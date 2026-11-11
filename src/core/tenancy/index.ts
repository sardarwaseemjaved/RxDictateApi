import { Types } from 'mongoose';
import type { Request, RequestHandler } from 'express';
import { Location, Membership, Practice } from '../../models';
import { AppError } from '../errors';
import catchAsync from '../../utils/catchAsync';
import { organisationTypeSchema, type OrganisationType, type Role } from '../../shared/roles';
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
 * Which locations a member may use: any location of their own practice for a
 * doctor or a medicine manager, and for a PA the ones they were assigned.
 */
export const allowedLocationsFor = (role: Role, locationIds: Types.ObjectId[]): Types.ObjectId[] | 'all' =>
  role === 'doctor' || role === 'medicineManager' ? 'all' : locationIds;

/** Where the clinic routes may be used: everything that is not about settings, today. */
export const CLINIC_ONLY: readonly OrganisationType[] = ['clinic'];

/** Every kind of organisation, for the routes any member of any of them may use. */
export const ANY_ORGANISATION: readonly OrganisationType[] = organisationTypeSchema.options;

/** RxDictate's own console: companies and the review queue's decisions. */
export const PLATFORM_ONLY: readonly OrganisationType[] = ['platform'];

/** A company's own portal: its profile and its products. */
export const COMPANY_ONLY: readonly OrganisationType[] = ['company'];

/** Whoever sends to the review queue: a company's products, a clinic's proposals. */
export const SENDERS: readonly OrganisationType[] = ['company', 'clinic'];

/**
 * What this person may do in this practice, with every check resolvePractice
 * makes and no Express: the realtime handshake runs exactly these.
 *
 * Membership is looked up every time rather than carried in the token, so
 * removing a PA takes effect immediately instead of whenever their access
 * token happens to expire.
 *
 * `allowed` is the kinds of organisation the route serves. A member of any
 * other kind is FORBIDDEN, after the membership checks, so a stranger still
 * learns nothing about an organisation that is not theirs.
 *
 * A suspended company's members are refused here, on every route they could
 * reach and on the socket, with ORGANISATION_SUSPENDED.
 */
export const practiceContextFor = async (
  userId: Types.ObjectId,
  practiceText: string,
  allowed: readonly OrganisationType[] = CLINIC_ONLY,
): Promise<Express.PracticeContext> => {
  const practiceId = asObjectId(practiceText, 'X-Practice-Id');

  const membership = await Membership.findOne({ practiceId, userId });

  /**
   * Removed and never a member are different facts and the app says different
   * things about them: one is "you were taken off this clinic", the other is
   * "this is not your clinic". Their sign-in itself is still good - they may
   * work at another clinic - so this is a 403 about one practice and not a 401.
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

  if (!allowed.includes(practice.type)) {
    throw new AppError(
      'FORBIDDEN',
      allowed.length === 1 && allowed[0] === 'clinic'
        ? 'This is only available in a clinic.'
        : 'This is not available here.',
    );
  }

  if (practice.status === 'suspended') {
    throw new AppError(
      'ORGANISATION_SUSPENDED',
      `${practice.name} has been suspended by RxDictate. Its products stay live; nothing else can be done until it is reactivated.`,
    );
  }

  return {
    practiceId,
    organisationType: practice.type,
    membershipId: membership._id,
    actorId: userId,
    role: membership.role,
    allowedLocationIds: allowedLocationsFor(membership.role, membership.locationIds),
  };
};

/**
 * Which organisation this request is about, from X-Practice-Id, for a route
 * that serves these kinds of organisation. The one place the kind is checked:
 * a route says which kinds it serves by which of these it mounts, never by
 * checking for itself.
 */
export const resolveOrganisation = (allowed: readonly OrganisationType[]): RequestHandler =>
  catchAsync(async (req, _res, next) => {
    if (!req.auth) {
      throw new AppError('UNAUTHENTICATED', 'Please authenticate');
    }

    const header = req.get(PRACTICE_HEADER);
    if (!header) {
      throw new AppError('PRACTICE_REQUIRED', 'X-Practice-Id is required');
    }

    req.ctx = await practiceContextFor(req.auth.userId, header, allowed);
    next();
  });

/**
 * Which clinic this request is about, from X-Practice-Id. Required on
 * everything except /auth and /me, and what every clinic route mounts, so a
 * platform member who sends the platform's id is FORBIDDEN from all of them
 * without any route saying so.
 */
export const resolvePractice: RequestHandler = resolveOrganisation(CLINIC_ONLY);

/**
 * The location an id names if this caller may use it, or why they may not.
 * Shared by the middleware below and the realtime handshake.
 */
export const checkLocation = async (ctx: Express.PracticeContext, header: string): Promise<Types.ObjectId | AppError> => {
  if (!Types.ObjectId.isValid(header)) {
    return new AppError('VALIDATION_ERROR', 'X-Location-Id is not a valid id');
  }
  const locationId = new Types.ObjectId(header);

  const location = await Location.findOne({ _id: locationId, practiceId: ctx.practiceId, deletedAt: null });
  if (!location) {
    // Deliberately a 403 and not a 404: whether a location exists in someone
    // else's practice is not this caller's business.
    return new AppError('LOCATION_NOT_ALLOWED', 'That location is not one of yours');
  }

  if (location.status === 'archived') {
    return new AppError('LOCATION_ARCHIVED', 'That location has been archived');
  }

  if (ctx.allowedLocationIds !== 'all') {
    const allowed = ctx.allowedLocationIds.some((id) => id.equals(locationId));
    if (!allowed) {
      return new AppError('LOCATION_NOT_ALLOWED', 'You do not work at that location');
    }
  }

  return locationId;
};

/**
 * Which location, from X-Location-Id. Mounted on visits, prescriptions, voice
 * and appointments, which are the records that belong to a place rather than
 * to the practice as a whole.
 *
 * Patients belong to the practice, and an assistant sees the ones linked to
 * the locations they work at - see the finder in patient.service.
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

  const checked = await checkLocation(ctx, header);
  if (checked instanceof AppError) {
    throw checked;
  }

  ctx.locationId = checked;
  next();
});

/**
 * X-Location-Id when it is sent and names a location this caller may use, and
 * nothing otherwise.
 *
 * For routes that do not belong to a place but want to know where the request
 * came from: registering a patient links them to the location they were
 * registered at. The apps always send the header. One that names somewhere
 * the caller does not work is ignored rather than refused, because the route
 * would have worked without it.
 */
export const resolveLocationIfSent: RequestHandler = catchAsync(async (req, _res, next) => {
  const { ctx } = req;
  const header = req.get(LOCATION_HEADER);
  if (ctx && header) {
    const checked = await checkLocation(ctx, header);
    if (!(checked instanceof AppError)) {
      ctx.locationId = checked;
    }
  }
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

export default {
  allowedLocationsFor,
  practiceContextFor,
  checkLocation,
  resolveOrganisation,
  resolvePractice,
  resolveLocation,
  resolveLocationIfSent,
  scopeFrom,
  locationFrom,
};
