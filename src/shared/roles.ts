import { z } from 'zod';

/**
 * What kind of organisation a practice is. A practice id is an organisation
 * id: the collection, the ids and every name the apps use stayed the same when
 * organisations got types.
 *
 * - `clinic`: what every practice was before, and what sign-up makes. A
 *   hospital is a larger clinic.
 * - `platform`: RxDictate itself. There is exactly one, made by
 *   `yarn platform:init`.
 * - `company`: a medicine company. Only the platform creates one, with its
 *   first admin, through `POST /companies`.
 */
export const organisationTypeSchema = z.enum(['clinic', 'platform', 'company']);
export type OrganisationType = z.infer<typeof organisationTypeSchema>;

/**
 * Who someone is inside one organisation. A user can hold a different role in
 * each organisation they belong to, which is why the role lives on the
 * membership and never on the user.
 *
 * Each role belongs to one organisation type (ROLES_BY_ORGANISATION_TYPE), and
 * a membership whose role does not fit its organisation is refused.
 */
export const roleSchema = z.enum([
  'doctor',
  'pa',
  'medicineManager',
  'patient',
  'platformAdmin',
  'reviewer',
  'contentManager',
  'companyAdmin',
  'companyEditor',
]);
export type Role = z.infer<typeof roleSchema>;

/**
 * Which roles each kind of organisation holds. `patient` is still reserved: no
 * route gives it out, and a patient's link is not a membership.
 */
export const ROLES_BY_ORGANISATION_TYPE: Record<OrganisationType, readonly Role[]> = {
  clinic: ['doctor', 'pa', 'medicineManager', 'patient'],
  platform: ['platformAdmin', 'reviewer', 'contentManager'],
  company: ['companyAdmin', 'companyEditor'],
};

/**
 * The role that runs an organisation that is not a clinic. Each keeps at least
 * one, the way a clinic keeps a doctor.
 */
export const ADMIN_ROLE_BY_ORGANISATION_TYPE: Record<Exclude<OrganisationType, 'clinic'>, Role> = {
  platform: 'platformAdmin',
  company: 'companyAdmin',
};

/**
 * Whether an organisation is open for its members. Only a company is ever
 * suspended, by the platform: its members are then refused everywhere with
 * ORGANISATION_SUSPENDED, its pending submissions wait, and its live products
 * stay live.
 */
export const organisationStatusSchema = z.enum(['active', 'suspended']);
export type OrganisationStatus = z.infer<typeof organisationStatusSchema>;

export const roleFitsOrganisation = (role: Role, type: OrganisationType): boolean =>
  ROLES_BY_ORGANISATION_TYPE[type].includes(role);

export const membershipStatusSchema = z.enum(['active', 'removed']);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

/**
 * Everything a caller can ask to do. Named `entity.verb`. The role -> action
 * table itself lives in `src/core/permissions`, deliberately in one place; this
 * list is here because the app needs the same names to hide UI it cannot use.
 */
export const ACTIONS = [
  'practice.read',
  'practice.update',

  'location.read',
  'location.create',
  'location.update',
  'location.archive',

  'member.read',
  'member.add',
  'member.update',
  'member.remove',

  'patient.read',
  'patient.search',
  'patient.create',
  'patient.update',
  'patient.history',
  // A patient's online access, as the clinic sees and controls it.
  'patient.portal.read',
  'patient.portal.invite',
  'patient.portal.manage',

  'visit.read',
  'visit.create',
  'visit.update',

  'prescription.read',
  'prescription.create',
  'prescription.update',
  'prescription.approve',
  'prescription.revise',
  'prescription.print',

  'voice.dictate',
  'voice.read',

  'drug.search',
  // A clinic's own item, offered to the national catalog. Goes to review.
  'drug.propose',
  // A company's products: new ones, changes, discontinuations and claims. Each goes to review.
  'drug.submit',

  'drugList.read',
  // A doctor's own list in this clinic, the medicines they add for themselves, and their typed rows.
  'drugList.own.manage',
  // The clinic's list, and the items only this clinic has.
  'drugList.clinic.manage',

  'template.read',
  'template.create',
  'template.update',
  'template.delete',

  'report.create',
  'report.read',
  'report.review',

  'appointment.read',
  'appointment.create',
  'appointment.cancel',

  'notification.read',

  // Reading the settings that apply to you, and setting your own.
  'settings.read',
  // A clinic's values and locks, which every member of it gets.
  'settings.organisation.update',
  // Values and locks for every organisation at once.
  'settings.platform.update',

  // Medicine companies, as the platform sees them.
  'company.read',
  'company.create',
  'company.update',
  'company.suspend',
  // A company member reading their own company's profile.
  'company.profile.read',

  // Deciding what the review queue holds: approve, reject, or ask for changes.
  'submission.review',
] as const;

export const actionSchema = z.enum(ACTIONS);
export type Action = (typeof ACTIONS)[number];
