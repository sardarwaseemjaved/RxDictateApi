import { Types } from 'mongoose';
import { Drug, DrugList, DrugUsage, type DrugDoc, type DrugListDoc, type IDrugListItem } from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { Scope } from '../core/db';
import type { DrugListItemView, DrugListOwner, ListDrugListQuery, PutDrugListItemBody, Usual } from '../shared/drug.schema';
import type { PageMeta } from '../shared';
import type { SubmissionSummary } from '../shared/submissionStatus';
import { findVisibleDrug, prefixOf, toDrugView } from './drugAccess.service';
import { latestSubmissionsFor } from './submissionLookup.service';

type Audited = Scope & { requestId?: string | null };

/** A doctor's own list is theirs in this clinic. The clinic's has no owner. */
const ownerIdOf = (scope: Scope, owner: DrugListOwner): Types.ObjectId | null => (owner === 'me' ? scope.actorId : null);

const findList = async (scope: Scope, owner: DrugListOwner): Promise<DrugListDoc | null> =>
  DrugList.findOne({ practiceId: scope.practiceId, ownerId: ownerIdOf(scope, owner) });

const itemOn = (list: DrugListDoc | null, drugId: Types.ObjectId | string): IDrugListItem | null =>
  list?.items.find((item) => item.drugId.equals(drugId)) ?? null;

const toItemView = (drug: DrugDoc, item: IDrugListItem, proposal: SubmissionSummary | null = null): DrugListItemView => ({
  drug: toDrugView(drug),
  usual: item.usual,
  addedAt: item.addedAt,
  proposal,
});

/** On the clinic's list, the latest proposal about each of these items. A doctor's own list has none. */
const proposalsFor = async (
  scope: Scope,
  owner: DrugListOwner,
  drugIds: Types.ObjectId[],
): Promise<Map<string, SubmissionSummary>> =>
  owner === 'clinic' ? latestSubmissionsFor(scope.practiceId, drugIds, ['drug.propose']) : new Map();

/** Tell whoever the list belongs to. */
export const announceMedicines = (scope: Scope, owner: DrugListOwner, drugId: Types.ObjectId): void => {
  if (owner === 'clinic') {
    emit('medicines.changed', { owner, practiceId: scope.practiceId, drugId, actorId: scope.actorId });
  } else {
    emit('medicines.changed', {
      owner: 'doctor',
      practiceId: scope.practiceId,
      doctorId: scope.actorId,
      drugId,
      actorId: scope.actorId,
    });
  }
};

/** The doctor's own list and the clinic's, by drug id, for a search to read. */
export const listsFor = async (
  scope: Scope,
): Promise<{ mine: Map<string, IDrugListItem>; clinic: Map<string, IDrugListItem> }> => {
  const lists = await DrugList.find({ practiceId: scope.practiceId, ownerId: { $in: [scope.actorId, null] } });
  const items = (ownerId: Types.ObjectId | null) =>
    new Map(
      (lists.find((list) => (ownerId ? list.ownerId?.equals(ownerId) : list.ownerId === null))?.items ?? []).map((item) => [
        String(item.drugId),
        item,
      ]),
    );
  return { mine: items(scope.actorId), clinic: items(null) };
};

/**
 * Put a drug on a list if it is not there, with no checks and no audit: for
 * callers that have already decided it may go there. Safe to run twice, and
 * says whether it changed anything.
 */
export const addToList = async (
  practiceId: Types.ObjectId,
  ownerId: Types.ObjectId | null,
  drugId: Types.ObjectId,
  addedBy: Types.ObjectId,
  usual: Usual | null = null,
): Promise<boolean> => {
  const list = await DrugList.findOneAndUpdate(
    { practiceId, ownerId },
    { $setOnInsert: { practiceId, ownerId, items: [] } },
    { upsert: true, new: true },
  );
  const added = await DrugList.updateOne(
    { _id: list._id, 'items.drugId': { $ne: drugId } },
    { $push: { items: { drugId, addedAt: new Date(), addedBy, usual } } },
  );
  return added.modifiedCount > 0;
};

/**
 * What may go on a list: an active national drug, the clinic's own items, and
 * on a doctor's own list their own typed rows. What the caller cannot see at
 * all is simply not found.
 */
const assertMayGoOn = (drug: DrugDoc, owner: DrugListOwner): void => {
  if (drug.status !== 'active') {
    throw new AppError('VALIDATION_ERROR', 'params.drugId: this medicine has been discontinued', [
      { field: 'params.drugId', message: 'has been discontinued' },
    ]);
  }
  if (drug.scope === 'doctor' && owner === 'clinic') {
    throw new AppError('VALIDATION_ERROR', "params.drugId: a doctor's own medicine cannot go on the clinic's list", [
      { field: 'params.drugId', message: "is a doctor's own medicine, and cannot go on the clinic's list" },
    ]);
  }
};

/** Audit and announce a drug going on a list. */
export const recordAdded = async (
  scope: Audited,
  owner: DrugListOwner,
  drugId: Types.ObjectId,
  usual: Usual | null = null,
): Promise<void> => {
  await writeAudit(scope, {
    action: 'drugList.add',
    entity: 'drug',
    entityId: drugId,
    after: { owner, usual },
    requestId: scope.requestId ?? null,
  });
  announceMedicines(scope, owner, drugId);
};

/** The item a drug has on a list, once it is known to be there. */
export const viewOfItem = async (scope: Scope, owner: DrugListOwner, drug: DrugDoc): Promise<DrugListItemView> => {
  const [list, proposals] = await Promise.all([findList(scope, owner), proposalsFor(scope, owner, [drug._id])]);
  return toItemView(drug, itemOn(list, drug._id)!, proposals.get(String(drug._id)) ?? null);
};

/** GET /drug-lists/:owner: a page of the list, by brand. Discontinued drugs stay, so their owner can take them off. */
export const listItems = async (
  scope: Scope,
  owner: DrugListOwner,
  query: ListDrugListQuery,
): Promise<{ items: DrugListItemView[]; meta: PageMeta }> => {
  const list = await findList(scope, owner);
  const prefix = query.q ? prefixOf(query.q) : null;
  const result = await Drug.paginate(
    {
      _id: { $in: (list?.items ?? []).map((item) => item.drugId) },
      ...(prefix ? { $or: [{ nameKeys: prefix }, { wordKeys: prefix }] } : {}),
    },
    { page: query.page, limit: query.limit, sortBy: 'brandKey:asc,strength:asc,_id:asc' },
  );
  const proposals = await proposalsFor(
    scope,
    owner,
    result.results.map((drug) => drug._id),
  );
  return {
    items: result.results.map((drug) => toItemView(drug, itemOn(list, drug._id)!, proposals.get(String(drug._id)) ?? null)),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

/** `usual: {}` says nothing, which is the same as no usual at all. */
const usualFrom = (usual: Usual | null): Usual | null => (usual && Object.keys(usual).length > 0 ? usual : null);

/**
 * PUT /drug-lists/:owner/items/:drugId: add the drug, or update its usual.
 * Sending it twice changes nothing, and writes nothing.
 *
 * A drug already on the list can still have its usual changed after it was
 * discontinued. Only adding one is refused.
 */
export const putItem = async (
  scope: Audited,
  owner: DrugListOwner,
  drugId: string,
  body: PutDrugListItemBody,
): Promise<DrugListItemView> => {
  const drug = await findVisibleDrug(scope, drugId);
  if (!drug) {
    throw AppError.notFound('Medicine');
  }

  const existing = itemOn(await findList(scope, owner), drug._id);
  const ownerId = ownerIdOf(scope, owner);

  if (!existing) {
    assertMayGoOn(drug, owner);
    const usual = usualFrom(body.usual ?? null);
    if (await addToList(scope.practiceId, ownerId, drug._id, scope.actorId, usual)) {
      await recordAdded(scope, owner, drug._id, usual);
    }
    return viewOfItem(scope, owner, drug);
  }

  if (body.usual !== undefined) {
    const usual = usualFrom(body.usual);
    if (JSON.stringify(usual) !== JSON.stringify(existing.usual)) {
      await DrugList.updateOne(
        { practiceId: scope.practiceId, ownerId, 'items.drugId': drug._id },
        { $set: { 'items.$.usual': usual } },
      );
      await writeAudit(scope, {
        action: 'drugList.update',
        entity: 'drug',
        entityId: drug._id,
        before: { owner, usual: existing.usual },
        after: { owner, usual },
        requestId: scope.requestId ?? null,
      });
      announceMedicines(scope, owner, drug._id);
    }
  }
  return viewOfItem(scope, owner, drug);
};

/**
 * DELETE /drug-lists/:owner/items/:drugId. Taking off what is not there is
 * already done, so it answers the same way and writes nothing. The drug stays
 * in the catalog, and a typed row stays the doctor's.
 */
export const removeItem = async (scope: Audited, owner: DrugListOwner, drugId: string): Promise<{ removed: boolean }> => {
  const id = new Types.ObjectId(drugId);
  const before = itemOn(await findList(scope, owner), id);
  if (!before) {
    return { removed: false };
  }

  await DrugList.updateOne(
    { practiceId: scope.practiceId, ownerId: ownerIdOf(scope, owner) },
    { $pull: { items: { drugId: id } } },
  );
  await writeAudit(scope, {
    action: 'drugList.remove',
    entity: 'drug',
    entityId: id,
    before: { owner, usual: before.usual },
    requestId: scope.requestId ?? null,
  });
  announceMedicines(scope, owner, id);
  return { removed: true };
};

/** How many of a doctor's words the speech-to-text prompt has room for. */
const NAMES_TO_HEAR = 40;

/**
 * The brands on this doctor's own list, the most prescribed first, for the
 * speech-to-text prompt: those are the words they say.
 */
export const namesOnDoctorsList = async (practiceId: Types.ObjectId, doctorId: Types.ObjectId): Promise<string[]> => {
  const list = await DrugList.findOne({ practiceId, ownerId: doctorId }).select('items.drugId');
  if (!list || list.items.length === 0) {
    return [];
  }
  const ids = list.items.map((item) => item.drugId);
  const [drugs, usage] = await Promise.all([
    Drug.find({ _id: { $in: ids }, status: 'active' }).select('brand'),
    DrugUsage.find({ practiceId, doctorId, drugId: { $in: ids } }).select('drugId count'),
  ]);
  const uses = new Map(usage.map((row) => [String(row.drugId), row.count]));
  const usesOf = (drug: DrugDoc) => uses.get(String(drug._id)) ?? 0;
  return [...drugs]
    .sort((a, b) => usesOf(b) - usesOf(a))
    .slice(0, NAMES_TO_HEAR)
    .map((drug) => drug.brand);
};

export default { listItems, putItem, removeItem, namesOnDoctorsList };
