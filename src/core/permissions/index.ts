import type { Request, RequestHandler } from 'express';
import { ACTIONS, type Action, type Role } from '../../shared/roles';
import { AppError } from '../errors';

/**
 * Who may do what. One table.
 *
 * The alternative is a role check inside each route, which is how an endpoint
 * ends up being the only one that forgot. Reading this file tells you the whole
 * answer, and a new action cannot be added without appearing here.
 *
 * Location scope is not expressed here because it is not a question of role: a
 * doctor may use any location of their own practice and a PA only the ones
 * they were assigned, and resolveLocation enforces that for every
 * location-scoped route.
 *
 * Neither is the kind of organisation, though it follows from the role: each
 * role belongs to one organisation type (ROLES_BY_ORGANISATION_TYPE), so a
 * platform right can only come from a platform membership. The clinic routes
 * also refuse any other kind of organisation in the tenancy middleware.
 *
 * GET /me hands each membership its row of this table as `can`, so the apps
 * hide exactly what this would refuse.
 */
const PERMISSIONS: Record<Action, readonly Role[]> = {
  // The practice and its locations are the doctor's to configure. A PA gets the
  // locations they work at from /me, so never needs to list them.
  'practice.read': ['doctor'],
  'practice.update': ['doctor'],

  'location.read': ['doctor'],
  'location.create': ['doctor'],
  'location.update': ['doctor'],
  'location.archive': ['doctor'],

  // Each organisation's own staff, by whoever runs it: a clinic's doctor, a
  // company's admin, the platform's admin. /members serves all three kinds and
  // the service keeps each to its own roles. Only a clinic edits a member: a
  // company's or the platform's role never changes, and there are no locations.
  'member.read': ['doctor', 'companyAdmin', 'platformAdmin'],
  'member.add': ['doctor', 'companyAdmin', 'platformAdmin'],
  'member.update': ['doctor'],
  'member.remove': ['doctor', 'companyAdmin', 'platformAdmin'],

  // Adding patients and running the day's list is most of the PA's job.
  'patient.read': ['doctor', 'pa'],
  'patient.search': ['doctor', 'pa'],
  'patient.create': ['doctor', 'pa'],
  'patient.update': ['doctor', 'pa'],
  'patient.history': ['doctor'],
  // Both, because a patient may well ask at the front desk.
  'patient.portal.read': ['doctor', 'pa'],
  'patient.portal.invite': ['doctor', 'pa'],
  'patient.portal.manage': ['doctor', 'pa'],

  'visit.read': ['doctor', 'pa'],
  'visit.create': ['doctor', 'pa'],
  'visit.update': ['doctor', 'pa'],

  // Writing and approving a prescription is the doctor's signature on a legal
  // document. The PA may read one and print it.
  'prescription.read': ['doctor', 'pa'],
  'prescription.print': ['doctor', 'pa'],
  'prescription.create': ['doctor'],
  'prescription.update': ['doctor'],
  'prescription.approve': ['doctor'],
  'prescription.revise': ['doctor'],

  'voice.dictate': ['doctor'],
  'voice.read': ['doctor'],

  // A medicine manager looks after the clinic's list and sees nothing else: no
  // patients, no visits, no prescriptions.
  'drug.search': ['doctor', 'medicineManager'],
  'drugList.read': ['doctor', 'medicineManager'],
  'drugList.own.manage': ['doctor'],
  'drugList.clinic.manage': ['doctor', 'medicineManager'],
  // Offering one of the clinic's own items to the national catalog.
  'drug.propose': ['doctor', 'medicineManager'],

  // A company's products reach every doctor, so everything a company sends goes
  // to review first. Both of a company's roles send; only an admin manages staff.
  'drug.submit': ['companyAdmin', 'companyEditor'],
  'company.profile.read': ['companyAdmin', 'companyEditor'],

  // A template is one doctor's prescribing habit, kept for that doctor.
  'template.read': ['doctor'],
  'template.create': ['doctor'],
  'template.update': ['doctor'],
  'template.delete': ['doctor'],

  // The PA files a report; saying it has been looked at is the doctor's call,
  // because that is what takes it off the "new reports" list.
  'report.create': ['doctor', 'pa'],
  'report.read': ['doctor', 'pa'],
  'report.review': ['doctor'],

  'appointment.read': ['doctor', 'pa'],
  'appointment.create': ['doctor', 'pa'],
  'appointment.cancel': ['doctor', 'pa'],

  // A medicine manager too, so a reminder they asked for reaches a bell they can open.
  'notification.read': ['doctor', 'pa', 'medicineManager'],

  // Everybody who works somewhere reads what applies to them and sets their
  // own, where the registry lets a person choose. Not a patient, who holds
  // nothing here: /portal answers to a patient's link, not to this table.
  'settings.read': [
    'doctor',
    'pa',
    'medicineManager',
    'platformAdmin',
    'reviewer',
    'contentManager',
    'companyAdmin',
    'companyEditor',
  ],
  'settings.organisation.update': ['doctor'],
  'settings.platform.update': ['platformAdmin'],

  // RxDictate checks a company before it exists, so only the platform makes,
  // edits and suspends one. A reviewer reads them to judge what they send.
  'company.read': ['platformAdmin', 'reviewer'],
  'company.create': ['platformAdmin'],
  'company.update': ['platformAdmin'],
  'company.suspend': ['platformAdmin'],

  // The review queue. contentManager gets nothing here: it is for announcements.
  'submission.review': ['platformAdmin', 'reviewer'],

  // Announcements are written and published by RxDictate's own team,
  // including sponsored ones set up for a company. A company's own arrive
  // through the review queue as drafts, and are published here too.
  'announcement.read': ['platformAdmin', 'contentManager'],
  'announcement.create': ['platformAdmin', 'contentManager'],
  'announcement.publish': ['platformAdmin', 'contentManager'],
  // Registrants' names and phones, which they agreed to give the organiser.
  'announcement.registrations.read': ['platformAdmin', 'contentManager'],
  // Everybody who works in a clinic sees what is meant for them. Never a
  // patient, a company or the platform.
  'announcement.view': ['doctor', 'pa', 'medicineManager'],
  // A company's own announcement goes through the review queue, sent by
  // whoever sends its products. Approving makes a draft RxDictate publishes.
  'announcement.submit': ['companyAdmin', 'companyEditor'],
  // Which doctors were shown, clicked or dismissed what. Only RxDictate's
  // admin: not a content manager, and never a company, which sees totals.
  'announcement.people.read': ['platformAdmin'],
};

export const can = (role: Role, action: Action): boolean => PERMISSIONS[action].includes(role);

/** Every action, with the roles that hold it. Answers "what can a PA do?" in one call. */
export const actionsFor = (role: Role): Action[] => ACTIONS.filter((action) => can(role, action));

/**
 * Sits between resolveLocation and validate, so a caller who may not do this at
 * all is turned away before the body is even parsed.
 */
export const requireCan =
  (action: Action): RequestHandler =>
  (req, _res, next) => {
    if (!req.ctx) {
      return next(new AppError('PRACTICE_REQUIRED', 'This route needs a practice'));
    }
    if (!can(req.ctx.role, action)) {
      return next(new AppError('FORBIDDEN', `A ${req.ctx.role} cannot ${action.replace(/\./g, ' ')}`));
    }
    return next();
  };

/**
 * For a route where which action applies depends on the request: which list,
 * or which kind of item. Mounted after validate when it reads the body.
 */
export const requireCanFor =
  (actionOf: (req: Request) => Action): RequestHandler =>
  (req, res, next) =>
    requireCan(actionOf(req))(req, res, next);

/**
 * For a route where each thing asked for has its own action, and the service
 * checks them one by one. Turns away whoever holds none of them before the
 * body is parsed.
 */
export const requireCanAny =
  (actions: readonly Action[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.ctx) {
      return next(new AppError('PRACTICE_REQUIRED', 'This route needs a practice'));
    }
    const { role } = req.ctx;
    if (!actions.some((action) => can(role, action))) {
      return next(new AppError('FORBIDDEN', `A ${role} cannot do this`));
    }
    return next();
  };

export default { can, actionsFor, requireCan, requireCanFor, requireCanAny };
