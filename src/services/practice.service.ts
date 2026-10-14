import type { Types } from 'mongoose';
import { Membership, Practice, User, type PracticeDoc } from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import type { Scope } from '../core/db';
import type { PracticeView, UpdatePracticeBody } from '../shared/practice.schema';
import type { CreatePracticeBody } from '../shared/auth.schema';
import type { MeView } from '../shared/me.schema';
import { bootstrapPractice } from './auth.service';
import { getMe } from './me.service';

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

/**
 * Set up a clinic for somebody who is already signed in.
 *
 * This is the "set up my clinic" button on the screen a phone lands on when
 * nobody has added it to one: they have a valid session already, so making
 * them verify a second code to use it would be asking for something we just
 * asked for.
 *
 * Needs no X-Practice-Id, because the whole point is that there is not one
 * yet. Answers CONFLICT rather than quietly making a second clinic for
 * somebody who already has one - that is the bug this endpoint exists to stop
 * happening by accident.
 */
export const createMyPractice = async (userId: Types.ObjectId, body: CreatePracticeBody): Promise<MeView> => {
  const user = await User.findById(userId);
  if (!user) {
    throw AppError.notFound('User');
  }

  const existing = await Membership.countDocuments({ userId: user._id, status: 'active' });
  if (existing > 0) {
    throw new AppError('CONFLICT', 'You already belong to a clinic.');
  }

  // The name the app collected on this screen, when it collected one: the
  // clinic is named after the doctor.
  if (body.name && !user.name) {
    user.name = body.name;
    await user.save();
  }

  await bootstrapPractice(user);

  // The same shape as GET /me, so the app can replace what it is holding.
  return getMe(user._id);
};

export default { getPractice, updatePractice, createMyPractice, toPracticeView };
