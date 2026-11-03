import { Types } from 'mongoose';
import logger from '../config/logger';
import { Drug, DrugUsage, drugKeys, identityKeyOf, normaliseName, type DrugDoc, type IDrug } from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { can } from '../core/permissions';
import type { Scope } from '../core/db';
import type {
  CreateDrugBody,
  DrugListItemView,
  DrugListOwner,
  DrugSuggestion,
  DrugView,
  SearchDrugsQuery,
  UpdateDrugBody,
} from '../shared/drug.schema';
import type { MedicineItem } from '../shared/prescription.schema';
import type { SettingValue } from '../shared/settings';
import { clinicRows, findVisibleDrug, nationalRows, prefixOf, toDrugView, visibleTo } from './drugAccess.service';
import { addToList, announceMedicines, listsFor, recordAdded, viewOfItem } from './drugList.service';
import { getSettings } from './settings.service';

export { toDrugView };

type Audited = Scope & { requestId?: string | null };
type Mode = SettingValue<'medicines.source'>;

interface Standing {
  inMine: boolean;
  inClinic: boolean;
  isUsed: boolean;
}

/**
 * The tiers of design §8. Lower comes first; nothing paid or promoted, by any
 * company, ever enters this.
 */
const TIER: Record<Mode, (standing: Standing) => number> = {
  myList: ({ isUsed }) => (isUsed ? 0 : 1),
  myListFirst: ({ inMine, inClinic }) => {
    if (inMine) return 0;
    return inClinic ? 1 : 2;
  },
  all: ({ inMine, isUsed, inClinic }) => {
    if (inMine) return 0;
    if (isUsed) return 1;
    return inClinic ? 2 : 3;
  },
};

const BY_NAME = { brandKey: 1, strength: 1, _id: 1 } as const;

/**
 * GET /drugs. The server applies the caller's effective `medicines.source`; the
 * apps only send what was typed.
 *
 * Two kinds of row are read. What is close to this doctor (their list, the
 * clinic's, what they have used) is a few hundred ids and is read whole. The
 * rest of the catalog may be tens of thousands of rows, but no row there has any
 * usage, so its order is just names that start with what was typed, then names
 * that contain it, each by name: only the first `limit` of those can ever appear.
 *
 * A doctor's typed row is only ever found through their own list, so one they
 * took off stays off. Another clinic's items and another doctor's rows are not
 * in any query here.
 */
export const searchDrugs = async (scope: Scope, query: SearchDrugsQuery): Promise<DrugSuggestion[]> => {
  const { q, limit, everywhere } = query;
  const mode: Mode = everywhere ? 'all' : (await getSettings(scope))['medicines.source'].value;

  const [{ mine, clinic }, usage] = await Promise.all([
    listsFor(scope),
    DrugUsage.find({ practiceId: scope.practiceId, doctorId: scope.actorId }).select('drugId count'),
  ]);
  const uses = new Map(usage.map((row) => [String(row.drugId), row.count]));

  const prefix = prefixOf(q);
  const nearIds = [...new Set([...mine.keys(), ...clinic.keys(), ...(mode === 'myList' ? [] : uses.keys())])];
  const near = (
    await Drug.find({
      _id: { $in: nearIds },
      status: 'active',
      $and: [{ $or: visibleTo(scope) }, { $or: [{ nameKeys: prefix }, { wordKeys: prefix }] }],
    })
  ).filter((drug) => drug.scope !== 'doctor' || mine.has(String(drug._id)));

  const wanted = limit + near.length;
  const catalog = async (keys: 'nameKeys' | 'wordKeys'): Promise<DrugDoc[]> =>
    Drug.find({
      $or: [nationalRows, clinicRows(scope)].map((rows) => ({ ...rows, status: 'active', [keys]: prefix })),
    })
      .sort(BY_NAME)
      .limit(wanted);

  const starting = mode === 'myList' ? [] : await catalog('nameKeys');
  const containing = mode === 'myList' || starting.length >= wanted ? [] : await catalog('wordKeys');

  const candidates = [...new Map([...near, ...starting, ...containing].map((drug) => [String(drug._id), drug])).values()];

  const typed = normaliseName(q);
  const ranked = candidates.map((drug) => {
    const id = String(drug._id);
    const count = uses.get(id) ?? 0;
    return {
      drug,
      id,
      count,
      tier: TIER[mode]({ inMine: mine.has(id), inClinic: clinic.has(id), isUsed: count > 0 }),
      contains: drug.nameKeys.some((name) => name.startsWith(typed)) ? 0 : 1,
    };
  });

  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.contains - b.contains ||
      b.count - a.count ||
      a.drug.brandKey.localeCompare(b.drug.brandKey) ||
      a.drug.strength.localeCompare(b.drug.strength) ||
      a.id.localeCompare(b.id),
  );

  return ranked.slice(0, limit).map(({ drug, id }) => ({
    ...toDrugView(drug),
    inMyList: mine.has(id),
    inClinicList: clinic.has(id),
    usual: mine.get(id)?.usual ?? clinic.get(id)?.usual ?? null,
  }));
};

/**
 * Of the rows a line could mean, the one to link: on this doctor's list, then
 * on the clinic's, then an active row before a discontinued one, and verified
 * before typed. The catalog can hold one product in several packs.
 */
const SCOPE_ORDER: Record<IDrug['scope'], number> = { national: 0, clinic: 1, doctor: 2 };

const bestOf = (rows: DrugDoc[], mine: Map<string, unknown>, clinic: Map<string, unknown>): DrugDoc | null => {
  const rank = (drug: DrugDoc): number[] => {
    const id = String(drug._id);
    return [mine.has(id) ? 0 : 1, clinic.has(id) ? 0 : 1, drug.status === 'active' ? 0 : 1, SCOPE_ORDER[drug.scope]];
  };
  const first = (a: number[], b: number[]): number => a.reduce((found, value, at) => found || value - b[at], 0);
  return [...rows].sort((a, b) => first(rank(a), rank(b)) || String(a._id).localeCompare(String(b._id)))[0] ?? null;
};

type MedicineLine = MedicineItem;

/** The name a linked line still has to answer to, or the link is out of date. */
const stillNames = (drug: DrugDoc, line: MedicineLine): boolean => drug.nameKeys.includes(normaliseName(line.name));

/**
 * Link each line to a drug this doctor can see.
 *
 * A line that has a drugId keeps it only while it holds: the row may have been
 * dropped by the migration, may be another doctor's, or the line may since have
 * been renamed. Otherwise it is treated as typed, and a line without a drugId
 * is linked to a row whose brand, strength and form match, ignoring case and
 * spacing. Nothing is created here.
 */
export const linkMedicines = async (scope: Scope, medicines: MedicineLine[]): Promise<MedicineLine[]> => {
  const ids = medicines.flatMap((line) => (line.drugId ? [line.drugId] : []));
  const held = new Map(
    (ids.length > 0 ? await Drug.find({ _id: { $in: ids }, $or: visibleTo(scope) }) : []).map((drug) => [
      String(drug._id),
      drug,
    ]),
  );

  const lines = medicines.map((line) => {
    const drug = line.drugId ? held.get(line.drugId) : undefined;
    return drug && stillNames(drug, line) ? line : { ...line, drugId: null };
  });

  const unlinked = lines.filter((line) => !line.drugId);
  if (unlinked.length === 0) {
    return lines;
  }

  const rows = await Drug.find({
    identityKey: {
      $in: unlinked.map((line) => identityKeyOf({ brand: line.name, strength: line.strength, form: line.form })),
    },
    status: { $in: ['active', 'discontinued'] },
    $or: visibleTo(scope),
  });
  if (rows.length === 0) {
    return lines;
  }

  const { mine, clinic } = await listsFor(scope);
  return lines.map((line) => {
    if (line.drugId) {
      return line;
    }
    const key = identityKeyOf({ brand: line.name, strength: line.strength, form: line.form });
    const match = bestOf(
      rows.filter((row) => row.identityKey === key),
      mine,
      clinic,
    );
    return match ? { ...line, drugId: String(match._id) } : line;
  });
};

/** The doctor's own row for what was typed. Two approvals at once end with one. */
const ownRowFor = async (scope: Audited, line: MedicineLine): Promise<Types.ObjectId> => {
  const fields = { brand: line.name.trim(), generic: '', strength: line.strength.trim(), form: line.form };
  const keys = drugKeys(fields);
  const where = { scope: 'doctor', practiceId: scope.practiceId, ownerId: scope.actorId, identityKey: keys.identityKey };
  const result = await Drug.findOneAndUpdate(
    where,
    {
      $setOnInsert: {
        ...where,
        ...fields,
        ...keys,
        pack: '',
        company: '',
        aliases: [],
        drapRegNo: null,
        source: 'typed',
        status: 'active',
        createdBy: scope.actorId,
      },
    },
    { upsert: true, new: true, includeResultMetadata: true },
  );
  const drug = result.value!;
  if (!result.lastErrorObject?.updatedExisting) {
    await writeAudit(scope, {
      action: 'drug.create',
      entity: 'drug',
      entityId: drug._id,
      after: { ...toDrugView(drug), for: 'me', from: 'approval' },
      requestId: scope.requestId ?? null,
    });
  }
  return drug._id;
};

/**
 * At approval: a line that is still unmatched becomes a `doctor` row, typed and
 * unverified, and the line gets its id. Every typed row a signed prescription
 * uses is on the doctor's list, including one they had taken off and have now
 * prescribed again.
 *
 * Each medicine on its own, so one that fails leaves only itself unlinked.
 */
export const settleMedicines = async (scope: Audited, medicines: MedicineLine[]): Promise<MedicineLine[]> => {
  const linked = await linkMedicines(scope, medicines);

  // Once per medicine, however many lines name it.
  const made = new Map<string, Types.ObjectId | null>();
  const unmatched = linked.filter((line) => !line.drugId);
  await unmatched.reduce<Promise<void>>(async (previous, line) => {
    await previous;
    const key = identityKeyOf({ brand: line.name, strength: line.strength, form: line.form });
    if (made.has(key)) {
      return;
    }
    try {
      made.set(key, await ownRowFor(scope, line));
    } catch (error) {
      logger.warn(`could not make a row for a typed medicine: ${(error as Error).message}`);
      made.set(key, null);
    }
  }, Promise.resolve());

  const settled = linked.map((line) => {
    if (line.drugId) {
      return line;
    }
    const id = made.get(identityKeyOf({ brand: line.name, strength: line.strength, form: line.form }));
    return id ? { ...line, drugId: String(id) } : line;
  });

  const own = await Drug.find({
    _id: { $in: settled.flatMap((line) => (line.drugId ? [line.drugId] : [])) },
    scope: 'doctor',
    practiceId: scope.practiceId,
    ownerId: scope.actorId,
  }).select('_id');
  await own.reduce<Promise<void>>(async (previous, drug) => {
    await previous;
    if (await addToList(scope.practiceId, scope.actorId, drug._id, scope.actorId)) {
      await recordAdded(scope, 'me', drug._id);
    }
  }, Promise.resolve());

  return settled;
};

/** Once per approval, and once per medicine however many lines name it. */
export const countDrugUsage = async (scope: Scope, medicines: MedicineLine[], at: Date): Promise<void> => {
  const ids = [...new Set(medicines.flatMap((line) => (line.drugId ? [line.drugId] : [])))];
  if (ids.length === 0) {
    return;
  }
  await DrugUsage.bulkWrite(
    ids.map((id) => ({
      updateOne: {
        filter: { practiceId: scope.practiceId, doctorId: scope.actorId, drugId: new Types.ObjectId(id) },
        update: { $inc: { count: 1 }, $max: { lastUsedAt: at } },
        upsert: true,
      },
    })),
  );
};

/**
 * POST /drugs: a medicine for the clinic's list or the doctor's own.
 *
 * An exact duplicate the caller can already see is reused and put on that list.
 * For the clinic's list that leaves out the caller's own typed rows, which can
 * only go on their own. Answers whether anything new was made.
 */
export const createDrug = async (
  scope: Audited,
  body: CreateDrugBody,
): Promise<{ item: DrugListItemView; created: boolean }> => {
  const { for: owner, ...fields } = body;
  const keys = drugKeys(fields);
  const isClinic = owner === 'clinic';

  const seen = await Drug.find({
    identityKey: keys.identityKey,
    status: 'active',
    $or: isClinic ? [nationalRows, clinicRows(scope)] : visibleTo(scope),
  });
  const { mine, clinic } = await listsFor(scope);
  const existing = bestOf(seen, mine, clinic);

  let drug: DrugDoc | null = existing;
  if (!drug) {
    const where = {
      scope: isClinic ? 'clinic' : 'doctor',
      practiceId: scope.practiceId,
      ownerId: isClinic ? null : scope.actorId,
      identityKey: keys.identityKey,
    };
    drug = await Drug.findOneAndUpdate(
      where,
      {
        $setOnInsert: {
          ...where,
          ...fields,
          ...keys,
          aliases: [],
          drapRegNo: null,
          source: isClinic ? 'clinic' : 'typed',
          status: 'active',
          createdBy: scope.actorId,
        },
      },
      { upsert: true, new: true },
    );
    await writeAudit(scope, {
      action: 'drug.create',
      entity: 'drug',
      entityId: drug!._id,
      after: { ...toDrugView(drug!), for: owner },
      requestId: scope.requestId ?? null,
    });
  }

  const { _id: drugId } = drug!;
  if (await addToList(scope.practiceId, isClinic ? null : scope.actorId, drugId, scope.actorId)) {
    await recordAdded(scope, owner, drugId);
  }
  return { item: await viewOfItem(scope, owner, drug!), created: !existing };
};

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number }).code === 11000;

/**
 * PATCH /drugs/:id: a clinic row by anyone who manages the clinic's list, and a
 * doctor row only by its doctor, which seeing it already proves. The national
 * catalog comes from the import and cannot be edited.
 */
export const updateDrug = async (scope: Audited, id: string, patch: UpdateDrugBody): Promise<DrugView> => {
  const drug = await findVisibleDrug(scope, id);
  if (!drug) {
    throw AppError.notFound('Medicine');
  }
  if (drug.scope === 'national') {
    throw new AppError('FORBIDDEN', 'The national catalog cannot be edited.');
  }
  const owner: DrugListOwner = drug.scope === 'clinic' ? 'clinic' : 'me';
  if (!can(scope.role, owner === 'clinic' ? 'drugList.clinic.manage' : 'drugList.own.manage')) {
    throw new AppError('FORBIDDEN', 'You cannot change this medicine.');
  }

  const before = toDrugView(drug);
  drug.set({ ...patch });
  if (!drug.isModified()) {
    return before;
  }
  drug.set(drugKeys(drug));

  try {
    await drug.save();
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError('CONFLICT', 'That medicine is already there.');
    }
    throw error;
  }

  const after = toDrugView(drug);
  await writeAudit(scope, {
    action: 'drug.update',
    entity: 'drug',
    entityId: drug._id,
    before,
    after,
    requestId: scope.requestId ?? null,
  });
  announceMedicines(scope, owner, drug._id);
  return after;
};

export default { searchDrugs, linkMedicines, settleMedicines, countDrugUsage, createDrug, updateDrug, toDrugView };
