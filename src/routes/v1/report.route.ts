import express from 'express';
import { reportController } from '../../controllers';
import { reportValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Step one of an upload: somewhere to PUT one page.
 *
 * Not under /patients, because the app asks for it before it has decided which
 * patient the report belongs to - and because a storage key is no place to
 * record who a document is about. With S3 or R2 the URL is the bucket's; with
 * the local driver it is this API's own signed /files route.
 */
router.post(
  '/uploads',
  requireAuth,
  resolvePractice,
  requireCan('report.create'),
  validate(reportValidation.createUpload),
  reportController.createUpload,
);

/** One report, with a short-lived link per page. */
router.get(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('report.read'),
  validate(reportValidation.getReport),
  reportController.getReport,
);

/**
 * The doctor has looked at it. Idempotent: the first review is the one kept.
 * Practice-wide like the rest of a patient's record, so a report brought to
 * one location can be reviewed from the other.
 */
router.post(
  '/:id/review',
  requireAuth,
  resolvePractice,
  requireCan('report.review'),
  validate(reportValidation.reviewReport),
  reportController.reviewReport,
);

export default router;
