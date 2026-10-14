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
 * record who a document is about. Answers STORAGE_UNAVAILABLE when the server
 * is running the local driver, which cannot sign an upload.
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

export default router;
