import type { RequestHandler } from 'express';
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
 * doctor may use any location of his practice and a PA only the ones she was
 * assigned, and resolveLocation enforces that for every location-scoped route.
 */
const PERMISSIONS: Record<Action, readonly Role[]> = {
  // The practice and its locations are the doctor's to configure. A PA gets the
  // locations she works at from /me, so she never needs to list them.
  'practice.read': ['doctor'],
  'practice.update': ['doctor'],

  'location.read': ['doctor'],
  'location.create': ['doctor'],
  'location.update': ['doctor'],
  'location.archive': ['doctor'],

  'member.read': ['doctor'],
  'member.add': ['doctor'],
  'member.update': ['doctor'],
  'member.remove': ['doctor'],

  // Adding patients and running the day's list is most of the PA's job.
  'patient.read': ['doctor', 'pa'],
  'patient.search': ['doctor', 'pa'],
  'patient.create': ['doctor', 'pa'],
  'patient.update': ['doctor', 'pa'],
  'patient.history': ['doctor'],

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

  'drug.search': ['doctor'],

  'template.read': ['doctor'],
  'template.create': ['doctor'],

  'report.create': ['doctor', 'pa'],
  'report.read': ['doctor', 'pa'],

  'appointment.read': ['doctor', 'pa'],
  'appointment.create': ['doctor', 'pa'],
  'appointment.cancel': ['doctor', 'pa'],

  'notification.read': ['doctor', 'pa'],
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
      return next(new AppError('FORBIDDEN', `A ${req.ctx.role} cannot ${action.replace('.', ' ')}`));
    }
    return next();
  };

export default { can, actionsFor, requireCan };
