import { Types } from 'mongoose';
import { Location, Membership, User, type IMembership, type MembershipDoc, type UserDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { AddMemberBody, ListMembersQuery, MemberView, UpdateMemberBody } from '../shared/team.schema';
import { revokeAllForUser } from './token.service';

// Memberships are retired by status rather than deletedAt: a removed PA's past
// actions stay attributable, and re-adding her reuses the row she already had.
const memberships = new BaseRepository<IMembership>(Membership, { softDelete: false });

const toMemberView = (membership: MembershipDoc, user: UserDoc | null): MemberView => ({
  id: String(membership._id),
  userId: String(membership.userId),
  name: user?.name ?? '',
  phone: user?.phone ?? '',
  role: membership.role,
  locationIds: membership.locationIds.map(String),
  status: membership.status,
});

const withUsers = async (found: MembershipDoc[]): Promise<MemberView[]> => {
  const users = await User.find({ _id: { $in: found.map((membership) => membership.userId) } });
  const byId = new Map(users.map((user) => [String(user._id), user]));
  return found.map((membership) => toMemberView(membership, byId.get(String(membership.userId)) ?? null));
};

export const listMembers = async (scope: Scope, query: ListMembersQuery): Promise<MemberView[]> =>
  withUsers(await memberships.find(scope, query.status ? { status: query.status } : {}, { sort: { createdAt: 1 } }));

/** Every id has to be a live location of this practice, or a PA gets access to nothing. */
const assertLocations = async (scope: Scope, locationIds: string[]): Promise<Types.ObjectId[]> => {
  const ids = locationIds.map((id) => new Types.ObjectId(id));
  const count = await Location.countDocuments({
    _id: { $in: ids },
    practiceId: scope.practiceId,
    status: 'active',
    deletedAt: null,
  });
  if (count !== ids.length) {
    throw new AppError('LOCATION_NOT_ALLOWED', 'One of those locations is not an active location of this clinic');
  }
  return ids;
};

/**
 * Added by phone number, with no invite code anywhere.
 *
 * The doctor types the number; the server finds or creates that user and gives
 * her a membership. If she already has an account from another clinic it is the
 * same user, with a second membership, and she notices nothing.
 */
export const addMember = async (scope: Scope, body: AddMemberBody): Promise<MemberView> => {
  const locationIds = await assertLocations(scope, body.locationIds);

  let user = await User.findOne({ phone: body.phone });
  if (!user) {
    user = await User.create({ phone: body.phone, name: body.name ?? '' });
  } else if (body.name && !user.name) {
    user.name = body.name;
    await user.save();
  }

  const existing = await Membership.findOne({ practiceId: scope.practiceId, userId: user._id });
  if (existing && existing.status === 'active') {
    throw new AppError('ALREADY_MEMBER', 'That number is already on this clinic');
  }

  // One row per person per practice, so a removed member is reactivated rather
  // than forked.
  const membership =
    existing ??
    new Membership({
      userId: user._id,
      practiceId: scope.practiceId,
      addedBy: scope.actorId,
      createdBy: scope.actorId,
    });

  membership.role = body.role;
  membership.locationIds = locationIds;
  membership.status = 'active';
  membership.removedAt = null;
  membership.addedBy = scope.actorId;
  await membership.save();

  const after = toMemberView(membership, user);
  await writeAudit(scope, {
    action: 'member.add',
    entity: 'membership',
    entityId: membership._id,
    after,
  });
  emit('member.added', {
    practiceId: scope.practiceId,
    membershipId: membership._id,
    userId: user._id,
    phone: user.phone,
    role: membership.role,
    actorId: scope.actorId,
  });

  return after;
};

export const updateMember = async (scope: Scope, id: string, patch: UpdateMemberBody): Promise<MemberView> => {
  const membership = await memberships.findByIdOrFail(scope, id, 'Member');
  const user = await User.findById(membership.userId);
  const before = toMemberView(membership, user);

  // The owner must stay a doctor, or a practice can be left with nobody who
  // can approve a prescription.
  if (patch.role && patch.role !== membership.role && membership.role === 'doctor') {
    const doctors = await memberships.count(scope, { role: 'doctor', status: 'active' });
    if (doctors <= 1) {
      throw new AppError('LAST_DOCTOR', 'A clinic needs at least one doctor');
    }
  }

  if (patch.role) membership.role = patch.role;
  const locationsChanged = patch.locationIds !== undefined;
  if (patch.locationIds) {
    membership.locationIds = await assertLocations(scope, patch.locationIds);
  }
  if (patch.name && user) {
    user.name = patch.name;
    await user.save();
  }

  await membership.save();
  const after = toMemberView(membership, user);

  await writeAudit(scope, { action: 'member.update', entity: 'membership', entityId: membership._id, before, after });
  if (locationsChanged) {
    emit('member.locationsChanged', {
      practiceId: scope.practiceId,
      membershipId: membership._id,
      userId: membership.userId,
      locationIds: membership.locationIds,
      actorId: scope.actorId,
    });
  }

  return after;
};

/**
 * Sets the membership to removed. Her sessions are revoked with it, so access
 * ends now rather than when her token expires, and everything she did stays in
 * the audit log under her name.
 */
export const removeMember = async (scope: Scope, id: string): Promise<MemberView> => {
  const membership = await memberships.findByIdOrFail(scope, id, 'Member');

  if (membership.role === 'doctor') {
    const doctors = await memberships.count(scope, { role: 'doctor', status: 'active' });
    if (doctors <= 1) {
      throw new AppError('LAST_DOCTOR', 'A clinic needs at least one doctor');
    }
  }

  const user = await User.findById(membership.userId);
  const before = toMemberView(membership, user);

  membership.status = 'removed';
  membership.removedAt = new Date();
  await membership.save();
  await revokeAllForUser(membership.userId);

  const after = toMemberView(membership, user);
  await writeAudit(scope, { action: 'member.remove', entity: 'membership', entityId: membership._id, before, after });
  emit('member.removed', {
    practiceId: scope.practiceId,
    membershipId: membership._id,
    userId: membership.userId,
    actorId: scope.actorId,
  });

  return after;
};

export default { listMembers, addMember, updateMember, removeMember };
