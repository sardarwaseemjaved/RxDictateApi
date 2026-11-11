import express from 'express';
import { submissionController } from '../../controllers';
import { submissionValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { PLATFORM_ONLY, SENDERS, resolveOrganisation } from '../../core/tenancy';
import { requireCan, requireCanAny } from '../../core/permissions';

const router = express.Router();

/**
 * The review queue. Each route says once which kinds of organisation it serves:
 *
 * - reading serves the platform, which sees every organisation's, and the
 *   senders - a company and a clinic - which see only their own;
 * - deciding serves the platform only;
 * - sending again and withdrawing serve the senders only.
 *
 * What is sent comes in through the routes it is about: /company/products for
 * a company, POST /drugs/:id/propose for a clinic.
 */
const READERS = [...PLATFORM_ONLY, ...SENDERS];

router.get(
  '/',
  requireAuth,
  resolveOrganisation(READERS),
  requireCanAny(['submission.review', 'drug.submit', 'drug.propose']),
  validate(submissionValidation.listSubmissions),
  submissionController.listSubmissions,
);

router.get(
  '/:id',
  requireAuth,
  resolveOrganisation(READERS),
  requireCanAny(['submission.review', 'drug.submit', 'drug.propose']),
  validate(submissionValidation.getSubmission),
  submissionController.getSubmission,
);

router.patch(
  '/:id',
  requireAuth,
  resolveOrganisation(SENDERS),
  requireCanAny(['drug.submit', 'drug.propose']),
  validate(submissionValidation.resubmit),
  submissionController.resubmit,
);

router.post(
  '/:id/withdraw',
  requireAuth,
  resolveOrganisation(SENDERS),
  requireCanAny(['drug.submit', 'drug.propose']),
  validate(submissionValidation.withdraw),
  submissionController.withdraw,
);

router.post(
  '/:id/approve',
  requireAuth,
  resolveOrganisation(PLATFORM_ONLY),
  requireCan('submission.review'),
  validate(submissionValidation.approve),
  submissionController.approve,
);

router.post(
  '/:id/reject',
  requireAuth,
  resolveOrganisation(PLATFORM_ONLY),
  requireCan('submission.review'),
  validate(submissionValidation.reject),
  submissionController.reject,
);

router.post(
  '/:id/request-changes',
  requireAuth,
  resolveOrganisation(PLATFORM_ONLY),
  requireCan('submission.review'),
  validate(submissionValidation.requestChanges),
  submissionController.requestChanges,
);

export default router;
