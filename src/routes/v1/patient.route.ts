import express from 'express';
import { patientController, reportController } from '../../controllers';
import { patientValidation, reportValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolveLocationIfSent, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Not location-scoped: a patient belongs to the whole practice. The doctor sees
 * all of them; an assistant sees the ones linked to a location they work at,
 * and anyone else is NOT_FOUND on every route here. patient.service decides,
 * in one place.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('patient.search'),
  validate(patientValidation.searchPatients),
  patientController.searchPatients,
);

/**
 * X-Location-Id is optional here but read when it is sent: it is where the
 * patient was registered, which links them to that location.
 */
router.post(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocationIfSent,
  requireCan('patient.create'),
  validate(patientValidation.createPatient),
  patientController.createPatient,
);

router.get(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('patient.read'),
  validate(patientValidation.getPatient),
  patientController.getPatient,
);

router.patch(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('patient.update'),
  validate(patientValidation.updatePatient),
  patientController.updatePatient,
);

/**
 * One timeline, newest first: visits with their vitals, prescriptions, ordered
 * labs and reports. Practice-wide, because a patient seen at two locations has
 * one history. The doctor's alone.
 */
router.get(
  '/:id/history',
  requireAuth,
  resolvePractice,
  requireCan('patient.history'),
  validate(patientValidation.getHistory),
  patientController.getHistory,
);

/**
 * Step two of an upload: the pages are already in storage, this records what
 * they are. Step one is POST /reports/uploads.
 */
router.post(
  '/:id/reports',
  requireAuth,
  resolvePractice,
  requireCan('report.create'),
  validate(reportValidation.createReport),
  reportController.createReport,
);

router.get(
  '/:id/reports',
  requireAuth,
  resolvePractice,
  requireCan('report.read'),
  validate(reportValidation.listReports),
  reportController.listReports,
);

export default router;
