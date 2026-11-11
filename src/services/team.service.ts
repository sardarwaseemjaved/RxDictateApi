import { Types } from 'mongoose';
import { Location, Membership, User, type IMembership, type MembershipDoc, type UserDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type {
  AddMemberBody,
  AddOrganisationMemberBody,
  ListMembersQuery,
  MemberView,
  UpdateMemberBody,
} from '../shared/team.schema';
import { ADMIN_ROLE_BY_ORGANISATION_TYPE, roleFitsOrganisation, type OrganisationType, type Role } from '../shared/roles';

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

/** The person with this phone, made if nobody has signed in with it yet. A name fills a blank one. */
const userFor = async (phone: string, name?: string): Promise<UserDoc> => {
  const user = await User.findOne({ phone });
  if (!user) {
    return User.create({ phone, name: name ?? '' });
  }
  if (name && !user.name) {
    user.name = name;
    await user.save();
  }
  return user;
};

/**
 * Give a person a role in an organisation, audit it, and say so.
 *
 * One row per person per organisation, so a removed member is reactivated
 * rather than forked. The membership model refuses a role that does not fit
 * the organisation, whoever calls this. Used by /members for every kind of
 * organisation and by the platform when it creates a company with its admin.
 */
export const grantMembership = async (
  scope: Scope,
  organisationType: OrganisationType,
  person: { phone: string; name?: string },
  role: Role,
  locationIds: Types.ObjectId[],
): Promise<MemberView> => {
  const user = await userFor(person.phone, person.name);

  const existing = await Membership.findOne({ practiceId: scope.practiceId, userId: user._id });
  if (existing && existing.status === 'active') {
    throw new AppError(
      'ALREADY_MEMBER',
      organisationType === 'clinic' ? 'That number is already on this clinic' : 'That number is already a member here',
    );
  }

  const membership =
    existing ??
    new Membership({
      userId: user._id,
      practiceId: scope.practiceId,
      addedBy: scope.actorId,
      createdBy: scope.actorId,
    });

  membership.role = role;
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
    organisationType,
    membershipId: membership._id,
    userId: user._id,
    phone: user.phone,
    role: membership.role,
    actorId: scope.actorId,
  });

  return after;
};

/**
 * Added by phone number, with no invite code anywhere.
 *
 * The doctor types the number; the server finds or creates that user and gives
 * them a membership. If they already have an account from another clinic it is
 * the same user, with a second membership, and they notice nothing.
 */
export const addMember = async (scope: Scope, body: AddMemberBody): Promise<MemberView> => {
  // A medicine manager reaches every location, so nothing is kept on the membership.
  const locationIds = body.role === 'medicineManager' ? [] : await assertLocations(scope, body.locationIds);
  return grantMembership(scope, 'clinic', body, body.role, locationIds);
};

/**
 * A company's staff by its admin, or the platform's by a platform admin: by
 * phone, with one of that organisation's roles, and no locations. A role from
 * another kind of organisation is refused here, before anyone is made.
 */
export const addOrganisationMember = async (
  scope: Scope,
  organisationType: Exclude<OrganisationType, 'clinic'>,
  body: AddOrganisationMemberBody,
): Promise<MemberView> => {
  if (!roleFitsOrganisation(body.role, organisationType)) {
    throw new AppError('VALIDATION_ERROR', `body.role: ${body.role} is not a role here`, [
      { field: 'body.role', message: `is not a role in a ${organisationType}` },
    ]);
  }
  return grantMembership(scope, organisationType, body, body.role, []);
};

export const updateMember = async (scope: Scope, id: string, patch: UpdateMemberBody): Promise<MemberView> => {
  const membership = await memberships.findByIdOrFail(scope, id, 'Member');
  const user = await User.findById(membership.userId);
  const before = toMemberView(membership, user);

  // A medicine manager stays one until they are removed, and has no locations to edit.
  const isManager = membership.role === 'medicineManager';
  if (isManager && patch.role) {
    throw new AppError('VALIDATION_ERROR', "body.role: a medicine manager's role cannot change", [
      { field: 'body.role', message: 'cannot change: remove them and add them again' },
    ]);
  }

  // The owner must stay a doctor, or a practice can be left with nobody who
  // can approve a prescription.
  if (patch.role && patch.role !== membership.role && membership.role === 'doctor') {
    const doctors = await memberships.count(scope, { role: 'doctor', status: 'active' });
    if (doctors <= 1) {
      throw new AppError('LAST_DOCTOR', 'A clinic needs at least one doctor');
    }
  }

  const roleChanged = patch.role !== undefined && patch.role !== membership.role;
  if (patch.role) membership.role = patch.role;
  const locationsChanged = patch.locationIds !== undefined && !isManager;
  if (patch.locationIds && !isManager) {
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
  if (roleChanged) {
    emit('member.roleChanged', {
      practiceId: scope.practiceId,
      membershipId: membership._id,
      userId: membership.userId,
      role: membership.role,
      locationIds: membership.locationIds,
      actorId: scope.actorId,
    });
  }

  return after;
};

/**
 * Sets the membership to removed.
 *
 * Their sessions are deliberately left alone: they may work at another clinic
 * on the same sign-in, and being taken off this one is not a reason to sign
 * them out of that one. Membership is read on every request, so their access
 * to this practice stops immediately anyway - resolvePractice answers
 * MEMBERSHIP_REMOVED, and their live connections to this clinic are closed
 * with the same code - and everything they did stays in the audit log under
 * their name.
 */
export const removeMember = async (
  scope: Scope,
  id: string,
  organisationType: OrganisationType = 'clinic',
): Promise<MemberView> => {
  const membership = await memberships.findByIdOrFail(scope, id, 'Member');

  if (organisationType === 'clinic' && membership.role === 'doctor') {
    const doctors = await memberships.count(scope, { role: 'doctor', status: 'active' });
    if (doctors <= 1) {
      throw new AppError('LAST_DOCTOR', 'A clinic needs at least one doctor');
    }
  }

  // A company or the platform keeps at least one admin, the way a clinic keeps a doctor.
  if (organisationType !== 'clinic') {
    const admin = ADMIN_ROLE_BY_ORGANISATION_TYPE[organisationType];
    if (membership.role === admin && membership.status === 'active') {
      const admins = await memberships.count(scope, { role: admin, status: 'active' });
      if (admins <= 1) {
        throw new AppError('LAST_ADMIN', 'There has to be at least one admin. Add another before removing this one.');
      }
    }
  }

  const user = await User.findById(membership.userId);
  const before = toMemberView(membership, user);

  membership.status = 'removed';
  membership.removedAt = new Date();
  await membership.save();

  const after = toMemberView(membership, user);
  await writeAudit(scope, { action: 'member.remove', entity: 'membership', entityId: membership._id, before, after });
  emit('member.removed', {
    practiceId: scope.practiceId,
    organisationType,
    membershipId: membership._id,
    userId: membership.userId,
    actorId: scope.actorId,
  });

  return after;
};

export default { listMembers, addMember, addOrganisationMember, grantMembership, updateMember, removeMember };
