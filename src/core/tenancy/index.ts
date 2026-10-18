import { Types } from 'mongoose';
import type { Request, RequestHandler } from 'express';
import { Location, Membership, Practice } from '../../models';
import { AppError } from '../errors';
import catchAsync from '../../utils/catchAsync';
import type { Scope } from '../db';

const PRACTICE_HEADER = 'x-practice-id';
const LOCATION_HEADER = 'x-location-id';

const asObjectId = (value: string, header: string): Types.ObjectId => {
  if (!Types.ObjectId.isValid(value)) {
    throw new AppError('VALIDATION_ERROR', `${header} is not a valid id`);
  }
  return new Types.ObjectId(value);
};

/**
 * Which practice this request is about, from X-Practice-Id.
 *
 * Required on everything except /auth and /me. Membership is looked up on every
 * request rather than carried in the token, so removing a PA takes effect
 * immediately instead of whenever her access token happens to expire.
 */
export const resolvePractice: RequestHandler = catchAsync(async (req, _res, next) => {
  if (!req.auth) {
    throw new AppError('UNAUTHENTICATED', 'Please authenticate');
  }

  const header = req.get(PRACTICE_HEADER);
  if (!header) {
    throw new AppError('PRACTICE_REQUIRED', 'X-Practice-Id is required');
  }
  const practiceId = asObjectId(header, 'X-Practice-Id');

  const membership = await Membership.findOne({ practiceId, userId: req.auth.userId });

  /**
   * Removed and never a member are different facts and the app says different
   * things about them: one is "you were taken off this clinic", the other is
   * "this is not your clinic". Her sign-in itself is still good - she may work
   * at another clinic - so this is a 403 about one practice and not a 401.
   */
  if (membership?.status === 'removed') {
    throw new AppError('MEMBERSHIP_REMOVED', 'You have been removed from this clinic.');
  }
  if (!membership || membership.status !== 'active') {
    throw new AppError('NOT_MEMBER', 'You do not have access to this clinic');
  }

  const practice = await Practice.findOne({ _id: practiceId, deletedAt: null });
  if (!practice) {
    throw AppError.notFound('Clinic');
  }

  req.ctx = {
    practiceId,
    membershipId: membership._id,
    actorId: req.auth.userId,
    role: membership.role,
    // A doctor may work at any location of his own practice; a PA is held to
    // the ones she was assigned.
    allowedLocationIds: membership.role === 'doctor' ? 'all' : membership.locationIds,
  };

  next();
});

/**
 * Which location, from X-Location-Id. Mounted on visits, prescriptions and
 * voice, which are the records that belong to a place rather than to the
 * practice as a whole.
 *
 * Patient search and history are deliberately practice-wide: a patient first
 * seen at one clinic must be findable at the other without being typed in
 * twice.
 */
export const resolveLocation: RequestHandler = catchAsync(async (req, _res, next) => {
  const { ctx } = req;
  if (!ctx) {
    throw new AppError('PRACTICE_REQUIRED', 'X-Practice-Id is required');
  }

  const header = req.get(LOCATION_HEADER);
  if (!header) {
    throw new AppError('LOCATION_REQUIRED', 'X-Location-Id is required on this route');
  }
  const locationId = asObjectId(header, 'X-Location-Id');

  const location = await Location.findOne({ _id: locationId, practiceId: ctx.practiceId, deletedAt: null });
  if (!location) {
    // Deliberately a 403 and not a 404: whether a location exists in someone
    // else's practice is not this caller's business.
    throw new AppError('LOCATION_NOT_ALLOWED', 'That location is not one of yours');
  }

  if (location.status === 'archived') {
    throw new AppError('LOCATION_ARCHIVED', 'That location has been archived');
  }

  if (ctx.allowedLocationIds !== 'all') {
    const allowed = ctx.allowedLocationIds.some((id) => id.equals(locationId));
    if (!allowed) {
      throw new AppError('LOCATION_NOT_ALLOWED', 'You do not work at that location');
    }
  }

  ctx.locationId = locationId;
  next();
});

/** The scope every repository call takes, built from what the middleware resolved. */
export const scopeFrom = (req: Request): Scope => {
  const { ctx } = req;
  if (!ctx) {
    throw new AppError('PRACTICE_REQUIRED', 'X-Practice-Id is required');
  }
  return {
    practiceId: ctx.practiceId,
    actorId: ctx.actorId,
    role: ctx.role,
    allowedLocationIds: ctx.allowedLocationIds,
    locationId: ctx.locationId,
  };
};

/** The location a location-scoped handler is working in. */
export const locationFrom = (req: Request): Types.ObjectId => {
  const locationId = req.ctx?.locationId;
  if (!locationId) {
    throw new AppError('LOCATION_REQUIRED', 'X-Location-Id is required on this route');
  }
  return locationId;
};

export default { resolvePractice, resolveLocation, scopeFrom, locationFrom };
