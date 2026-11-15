import { Types } from 'mongoose';
import { Location, Membership, Practice, User } from '../models';
import {
  audienceRoleSchema,
  type AnnouncementPeopleQuery,
  type AnnouncementPersonView,
  type AudienceRole,
} from '../shared/announcement.schema';
import { escapeRegex } from '../utils/regex';
import { typedPhoneToE164 } from '../utils/phone';

/**
 * Clinic members as RxDictate's console names them: found by name or phone to
 * choose for an audience, and named on an announcement that chooses them and
 * on the "who saw what" rows. Never reached by a company.
 *
 * Only people active in a clinic that exists, in a clinic role, are ever
 * found. A patient, a company's member and the platform's own are not clinic
 * members, so they never appear, even when they share a name.
 */

const CLINIC_ROLES: readonly AudienceRole[] = audienceRoleSchema.options;

/** The most people a search looks at before narrowing to clinic members. Plenty at this scale. */
const SEARCH_CANDIDATES = 500;

/**
 * People, each as they stand now: their roles, clinics and cities across the
 * clinics they are active in. Someone in none has those empty and is still
 * named; someone deleted is not in the map.
 */
export const peopleByIds = async (
  ids: readonly (Types.ObjectId | string)[],
): Promise<Map<string, AnnouncementPersonView>> => {
  const unique = [...new Set(ids.map(String))].filter((id) => Types.ObjectId.isValid(id));
  if (unique.length === 0) {
    return new Map();
  }
  const [users, memberships] = await Promise.all([
    User.find({ _id: { $in: unique } }).select('name phone specialties'),
    Membership.find({ userId: { $in: unique }, status: 'active', role: { $in: CLINIC_ROLES } }).select(
      'userId practiceId role',
    ),
  ]);
  const practiceIds = [...new Set(memberships.map((membership) => String(membership.practiceId)))];
  const [clinics, locations] = await Promise.all([
    practiceIds.length > 0
      ? Practice.find({ _id: { $in: practiceIds }, type: 'clinic', deletedAt: null }).select('name')
      : Promise.resolve([]),
    practiceIds.length > 0
      ? Location.find({ practiceId: { $in: practiceIds }, status: 'active', deletedAt: null }).select('practiceId city')
      : Promise.resolve([]),
  ]);
  const clinicName = new Map(clinics.map((clinic) => [String(clinic._id), clinic.name]));

  return new Map(
    users.map((user) => {
      const theirs = memberships.filter(
        (membership) => membership.userId.equals(user._id) && clinicName.has(String(membership.practiceId)),
      );
      const clinicIds = [...new Set(theirs.map((membership) => String(membership.practiceId)))];
      const cities = locations
        .filter((location) => clinicIds.includes(String(location.practiceId)) && location.city)
        .map((location) => location.city as string);
      const view: AnnouncementPersonView = {
        id: String(user._id),
        name: user.name,
        phone: user.phone,
        roles: CLINIC_ROLES.filter((role) => theirs.some((membership) => membership.role === role)),
        specialties: [...user.specialties],
        clinics: clinicIds.map((id) => ({ id, name: clinicName.get(id) ?? '' })),
        cities: [...new Set(cities)].sort((a, b) => a.localeCompare(b)),
      };
      return [String(user._id), view];
    }),
  );
};

/**
 * `GET /announcements/people`: clinic members by name, anywhere in it and
 * ignoring case, or by phone from its start, typed local or in E.164. A whole
 * number that matches comes first, then by name.
 */
export const searchPeople = async (query: AnnouncementPeopleQuery): Promise<AnnouncementPersonView[]> => {
  const phone = typedPhoneToE164(query.q);
  const byName = { name: { $regex: escapeRegex(query.q), $options: 'i' } };
  const candidates = await User.find(phone ? { $or: [byName, { phone: { $regex: `^${escapeRegex(phone)}` } }] } : byName)
    .select('_id')
    .limit(SEARCH_CANDIDATES);
  if (candidates.length === 0) {
    return [];
  }

  // Active in a clinic that exists, in the role asked for or any clinic role.
  const memberships = await Membership.find({
    userId: { $in: candidates.map((user) => user._id) },
    status: 'active',
    role: query.role ? query.role : { $in: CLINIC_ROLES },
  }).select('userId practiceId');
  const clinicIds = new Set(
    (
      await Practice.find({
        _id: { $in: [...new Set(memberships.map((membership) => String(membership.practiceId)))] },
        type: 'clinic',
        deletedAt: null,
      }).select('_id')
    ).map((clinic) => String(clinic._id)),
  );
  const found = [
    ...new Set(
      memberships
        .filter((membership) => clinicIds.has(String(membership.practiceId)))
        .map((membership) => String(membership.userId)),
    ),
  ];

  const people = [...(await peopleByIds(found)).values()];
  const rank = (person: AnnouncementPersonView): number => (phone && person.phone === phone ? 0 : 1);
  return people
    .sort(
      (a, b) =>
        rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id),
    )
    .slice(0, query.limit);
};

export default { peopleByIds, searchPeople };
