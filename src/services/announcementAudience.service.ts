import type { Types } from 'mongoose';
import { Location, Membership, Practice, User, type IAnnouncementAudience } from '../models';
import type { Scope } from '../core/db';
import { allowedLocationsFor } from '../core/tenancy';
import { audienceRoleSchema, type AnnouncementAudience, type AudienceRole } from '../shared/announcement.schema';
import type { Province } from '../shared/location.schema';
import type { Role } from '../shared/roles';
import type { Specialty } from '../shared/specialties';

/**
 * Who an announcement is for (section 6 of the design), as one rule used in
 * both directions: a member's slot asks "is this for me?", and the console
 * asks "how many is this for?". Both go through matchesAudience, so the count
 * and what people see cannot disagree.
 */

/** One clinic member, as an audience sees them. */
export interface AudienceMember {
  userId: string;
  organisationId: string;
  role: Role;
  specialties: readonly Specialty[];
  /** The locations that count: the one the app is open at, or every one they work at. */
  locations: readonly { province: Province | null; city: string | null }[];
}

/** An empty list matches everyone; a filled one needs one of its values. */
const oneOf = <T>(wanted: readonly T[], has: readonly T[]): boolean =>
  wanted.length === 0 || has.some((value) => wanted.includes(value));

const lower = (values: readonly (string | null)[]): string[] =>
  values.flatMap((value) => (value ? [value.toLowerCase()] : []));

/**
 * Whether an audience includes this member. Every list that is filled must
 * match; a list left empty does not narrow it. Only clinic roles ever match.
 */
export const matchesAudience = (audience: AnnouncementAudience | IAnnouncementAudience, member: AudienceMember): boolean =>
  audienceRoleSchema.options.includes(member.role as AudienceRole) &&
  oneOf(audience.roles, [member.role as AudienceRole]) &&
  oneOf(audience.specialties, member.specialties) &&
  oneOf(
    audience.provinces,
    member.locations.flatMap((location) => (location.province ? [location.province] : [])),
  ) &&
  oneOf(lower(audience.cities), lower(member.locations.map((location) => location.city))) &&
  oneOf(audience.organisationIds.map(String), [member.organisationId]) &&
  oneOf(audience.userIds.map(String), [member.userId]);

/**
 * The member asking, from their active membership: the location their app is
 * open at (X-Location-Id) when it sent one, otherwise every active location
 * they may work at.
 */
export const memberFor = async (scope: Scope): Promise<AudienceMember> => {
  let where = {};
  if (scope.locationId) {
    where = { _id: scope.locationId };
  } else if (scope.allowedLocationIds !== 'all') {
    where = { _id: { $in: scope.allowedLocationIds } };
  }
  const [user, locations] = await Promise.all([
    User.findById(scope.actorId).select('specialties'),
    Location.find({ practiceId: scope.practiceId, status: 'active', deletedAt: null, ...where }).select('province city'),
  ]);
  return {
    userId: String(scope.actorId),
    organisationId: String(scope.practiceId),
    role: scope.role,
    specialties: user?.specialties ?? [],
    locations: locations.map((location) => ({ province: location.province, city: location.city })),
  };
};

/**
 * How many people an audience reaches now: active members of clinics, in a
 * clinic role, who match. A person in two clinics counts once. Reads every
 * clinic membership the role and organisation filters leave, which is fine at
 * this scale; a larger one would push the filters into the query.
 */
export const countAudience = async (audience: AnnouncementAudience): Promise<number> => {
  const roles = audience.roles.length > 0 ? audience.roles : audienceRoleSchema.options;
  const memberships = await Membership.find({
    status: 'active',
    role: { $in: roles },
    ...(audience.organisationIds.length > 0 ? { practiceId: { $in: audience.organisationIds } } : {}),
    ...(audience.userIds.length > 0 ? { userId: { $in: audience.userIds } } : {}),
  }).select('userId practiceId role locationIds');
  if (memberships.length === 0) {
    return 0;
  }

  const practiceIds = [...new Set(memberships.map((membership) => String(membership.practiceId)))];
  const userIds = [...new Set(memberships.map((membership) => String(membership.userId)))];
  const [clinics, locations, users] = await Promise.all([
    Practice.find({ _id: { $in: practiceIds }, type: 'clinic', deletedAt: null }).select('_id'),
    Location.find({ practiceId: { $in: practiceIds }, status: 'active', deletedAt: null }).select(
      'practiceId province city',
    ),
    User.find({ _id: { $in: userIds } }).select('specialties'),
  ]);
  const isClinic = new Set(clinics.map((clinic) => String(clinic._id)));
  const specialtiesOf = new Map(users.map((user) => [String(user._id), user.specialties]));

  const reached = new Set<string>();
  memberships.forEach((membership) => {
    const organisationId = String(membership.practiceId);
    if (!isClinic.has(organisationId)) {
      return;
    }
    const allowed = allowedLocationsFor(membership.role, membership.locationIds);
    const theirs = locations.filter(
      (location) =>
        String(location.practiceId) === organisationId &&
        (allowed === 'all' || allowed.some((id: Types.ObjectId) => id.equals(location._id))),
    );
    const member: AudienceMember = {
      userId: String(membership.userId),
      organisationId,
      role: membership.role,
      specialties: specialtiesOf.get(String(membership.userId)) ?? [],
      locations: theirs.map((location) => ({ province: location.province, city: location.city })),
    };
    if (matchesAudience(audience, member)) {
      reached.add(member.userId);
    }
  });
  return reached.size;
};

export default { matchesAudience, memberFor, countAudience };
