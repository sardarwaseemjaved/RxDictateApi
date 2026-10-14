import { Practice, type PracticeDoc } from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import type { Scope } from '../core/db';
import type { PracticeView, UpdatePracticeBody } from '../shared/practice.schema';

/**
 * The practices collection is the one place the scoping key is the document's
 * own _id rather than a practiceId field, so BaseRepository has nothing to
 * filter and this is the single accessor instead. Everything in this file goes
 * through it.
 */
const load = async (scope: Scope): Promise<PracticeDoc> => {
  const practice = await Practice.findOne({ _id: scope.practiceId, deletedAt: null });
  if (!practice) {
    throw AppError.notFound('Clinic');
  }
  return practice;
};

export const toPracticeView = (practice: PracticeDoc): PracticeView => ({
  id: String(practice._id),
  name: practice.name,
  ownerId: String(practice.ownerId),
  pmdcNo: practice.pmdcNo,
  qualifications: practice.qualifications,
  speciality: practice.speciality,
  features: practice.features,
  settings: practice.settings,
});

export const getPractice = async (scope: Scope): Promise<PracticeView> => toPracticeView(await load(scope));

export const updatePractice = async (scope: Scope, patch: UpdatePracticeBody): Promise<PracticeView> => {
  const practice = await load(scope);
  const before = toPracticeView(practice);

  if (patch.name !== undefined) practice.name = patch.name;
  if (patch.pmdcNo !== undefined) practice.pmdcNo = patch.pmdcNo;
  if (patch.qualifications !== undefined) practice.qualifications = patch.qualifications;
  if (patch.speciality !== undefined) practice.speciality = patch.speciality;
  // Merged rather than replaced, so a client that knows about one flag cannot
  // reset the ones it has never heard of.
  if (patch.features) practice.features = { ...practice.features, ...patch.features };
  if (patch.settings) practice.settings = { ...practice.settings, ...patch.settings };

  await practice.save();
  const after = toPracticeView(practice);

  await writeAudit(scope, { action: 'practice.update', entity: 'practice', entityId: practice._id, before, after });
  return after;
};

export default { getPractice, updatePractice, toPracticeView };
