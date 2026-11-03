import type { Types } from 'mongoose';
import { Drug, DrugUsage, drugKeys, identityKeyOf, Prescription, type IDrug } from '../models';
import { writeAudit } from '../core/audit';
import { addToList } from './drugList.service';
import { auditOnPlatform } from './drugImport.service';

export interface MigrationSummary {
  dryRun: boolean;
  /** Rows from before scopes existed that this run looked at. */
  typedRows: number;
  /** One per doctor per clinic per medicine. */
  doctorRows: number;
  /** Rows no approved prescription used. */
  dropped: { brand: string; strength: string; form: string }[];
}

/** A row from before scopes existed, read without the model's defaults. */
type LegacyRow = Pick<IDrug, 'brand' | 'generic' | 'strength' | 'form' | 'company' | 'aliases'> & {
  _id: Types.ObjectId;
};

interface Group {
  practiceId: Types.ObjectId;
  doctorId: Types.ObjectId;
  row: LegacyRow;
  prescriptions: Set<string>;
  lastUsedAt: Date;
}

interface ApprovedLine {
  drugId?: Types.ObjectId | null;
  name: string;
  strength?: string;
  form?: IDrug['form'];
}

interface ApprovedPrescription {
  _id: Types.ObjectId;
  practiceId: Types.ObjectId;
  doctorId: Types.ObjectId;
  approvedBy?: Types.ObjectId | null;
  approvedAt?: Date | null;
  createdAt: Date;
  sections?: { medicines?: ApprovedLine[] };
}

const rowKey = (row: LegacyRow): string =>
  identityKeyOf({ brand: row.brand, strength: row.strength ?? '', form: row.form ?? 'tab' });

const lineKey = (line: ApprovedLine): string =>
  identityKeyOf({ brand: line.name, strength: line.strength ?? '', form: line.form ?? 'tab' });

/**
 * `yarn drugs:migrate-typed`, once: every row in `drugs` from before the import
 * came from typing, and none of it stays national.
 *
 * Each becomes a `doctor` row for each doctor who prescribed it in a prescription
 * that was approved, in that clinic, on that doctor's list there. A row nobody
 * prescribed that way is dropped. Prescriptions are not touched: each keeps its
 * own copy of every line.
 *
 * Safe to run twice, because the rows it works on are the ones with no scope,
 * and it deletes them last. A run that stopped halfway goes round again and
 * lands on the same rows, the same lists and the same counts. Usage is worked
 * out from the prescriptions rather than added to, for the same reason. A
 * superseded prescription was approved once, so it counts, as it would have
 * then.
 */
export const migrateTypedDrugs = async ({ dryRun = false }: { dryRun?: boolean } = {}): Promise<MigrationSummary> => {
  const legacy = await Drug.find({ scope: null }).lean<LegacyRow[]>();
  if (legacy.length === 0) {
    return { dryRun, typedRows: 0, doctorRows: 0, dropped: [] };
  }

  const byId = new Map(legacy.map((row) => [String(row._id), row]));
  const byKey = new Map(legacy.map((row) => [rowKey(row), row]));
  // Approved since this code went live but before this script ran: the line was linked to a row of the doctor's own.
  const typedSince = new Set((await Drug.find({ scope: 'doctor' }).select('_id').lean()).map((row) => String(row._id)));

  const groups = new Map<string, Group>();
  const usedRows = new Set<string>();

  const rowOf = (line: ApprovedLine): LegacyRow | undefined => {
    const id = line.drugId ? String(line.drugId) : null;
    if (id && byId.has(id)) {
      return byId.get(id);
    }
    return !id || typedSince.has(id) ? byKey.get(lineKey(line)) : undefined;
  };

  await Prescription.find({ status: { $in: ['approved', 'superseded'] }, deletedAt: null })
    .select('practiceId doctorId approvedBy approvedAt createdAt sections.medicines')
    .lean<ApprovedPrescription[]>()
    .cursor()
    .eachAsync((prescription: ApprovedPrescription) => {
      const doctorId = prescription.approvedBy ?? prescription.doctorId;
      const lastUsedAt = prescription.approvedAt ?? prescription.createdAt;
      (prescription.sections?.medicines ?? []).forEach((line) => {
        const row = rowOf(line);
        if (!row) {
          return;
        }
        usedRows.add(String(row._id));
        const key = `${String(prescription.practiceId)}|${String(doctorId)}|${rowKey(row)}`;
        const group = groups.get(key) ?? {
          practiceId: prescription.practiceId,
          doctorId,
          row,
          prescriptions: new Set<string>(),
          lastUsedAt,
        };
        group.prescriptions.add(String(prescription._id));
        group.lastUsedAt = group.lastUsedAt > lastUsedAt ? group.lastUsedAt : lastUsedAt;
        groups.set(key, group);
      });
    });

  const dropped = legacy
    .filter((row) => !usedRows.has(String(row._id)))
    .map(({ brand, strength, form }) => ({ brand, strength: strength ?? '', form }));
  const summary: MigrationSummary = { dryRun, typedRows: legacy.length, doctorRows: groups.size, dropped };
  if (dryRun) {
    return summary;
  }

  const madeByDoctor = new Map<
    string,
    { practiceId: Types.ObjectId; doctorId: Types.ObjectId; drugIds: Types.ObjectId[] }
  >();

  await [...groups.values()].reduce<Promise<void>>(async (previous, group) => {
    await previous;
    const { practiceId, doctorId, row } = group;
    const fields = {
      brand: row.brand,
      generic: row.generic ?? '',
      strength: row.strength ?? '',
      form: row.form ?? ('tab' as const),
      company: row.company ?? '',
      aliases: row.aliases ?? [],
    };
    const keys = drugKeys(fields);
    const where = { scope: 'doctor', practiceId, ownerId: doctorId, identityKey: keys.identityKey };
    const drug = await Drug.findOneAndUpdate(
      where,
      {
        $setOnInsert: {
          ...where,
          ...fields,
          ...keys,
          pack: '',
          drapRegNo: null,
          source: 'typed',
          status: 'active',
          createdBy: doctorId,
        },
      },
      { upsert: true, new: true },
    );

    await addToList(practiceId, doctorId, drug._id, doctorId);
    await DrugUsage.updateOne(
      { practiceId, doctorId, drugId: drug._id },
      { $set: { count: group.prescriptions.size, lastUsedAt: group.lastUsedAt } },
      { upsert: true },
    );

    const mine = `${String(practiceId)}|${String(doctorId)}`;
    const made = madeByDoctor.get(mine) ?? { practiceId, doctorId, drugIds: [] };
    made.drugIds.push(drug._id);
    madeByDoctor.set(mine, made);
  }, Promise.resolve());

  await Promise.all(
    [...madeByDoctor.values()].map(({ practiceId, doctorId, drugIds }) =>
      writeAudit(
        { practiceId, actorId: doctorId, role: 'doctor', allowedLocationIds: 'all' },
        { action: 'drug.migrateTyped', entity: 'drug', after: { drugIds: drugIds.map(String), by: 'script' } },
      ),
    ),
  );

  await Drug.deleteMany({ _id: { $in: legacy.map((row) => row._id) }, scope: null });
  await auditOnPlatform('drug.migrateTyped', { typedRows: summary.typedRows, doctorRows: summary.doctorRows, dropped });

  return summary;
};

export default { migrateTypedDrugs };
