import type { RequestHandler } from 'express';
import { Patient, PatientLink, LIVE_LINK_STATUSES } from '../models';
import { AppError } from '../core/errors';
import { hasLapsed, portalIsOn, settleLapsedLink } from '../services/patientLink.service';
import type { PortalRecord } from '../services/portal.service';
import catchAsync from '../utils/catchAsync';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The one place access to a patient's records is decided. On every record route
 * under /portal/links/:linkId, and nothing below it decides again.
 *
 * Someone else's link, or one that was removed, is NOT_FOUND. The caller's own
 * link that can't serve right now is PORTAL_LINK_UNAVAILABLE, and GET
 * /portal/links says why. The phone is checked as well as the link's status, so
 * there is no moment after a clinic changes a record's phone when it still serves.
 */
const resolvePortalLink: RequestHandler = catchAsync(async (req, _res, next) => {
  const auth = req.auth!;

  const link = await PatientLink.findOne({
    _id: req.params.linkId,
    userId: auth.userId,
    status: { $in: LIVE_LINK_STATUSES },
  });
  if (!link) {
    throw AppError.notFound('Link');
  }

  await settleLapsedLink(link);

  const [patient, enabled] = await Promise.all([
    Patient.findOne({ _id: link.patientId, practiceId: link.practiceId, deletedAt: null }),
    portalIsOn(link.practiceId),
  ]);
  if (
    link.status !== 'active' ||
    hasLapsed(link) ||
    !enabled ||
    !patient ||
    patient.portalBlocked ||
    patient.phone !== auth.phone
  ) {
    throw new AppError('PORTAL_LINK_UNAVAILABLE', 'This record is not available right now.');
  }

  // At most once a day: this runs on every read.
  const now = Date.now();
  if (now - link.lastUsedAt.getTime() >= DAY_MS) {
    await PatientLink.updateOne(
      { _id: link._id, lastUsedAt: { $lte: new Date(now - DAY_MS) } },
      { $set: { lastUsedAt: new Date(now) } },
    );
  }

  req.portal = { link, patient } satisfies PortalRecord;
  next();
});

export default resolvePortalLink;
