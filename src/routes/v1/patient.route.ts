import express from 'express';
import { patientController } from '../../controllers';
import { patientValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import notImplemented from '../../middlewares/notImplemented';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Practice-wide and not location-scoped, on purpose: a patient first seen at one
 * location has to be findable at the other without being entered twice.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('patient.search'),
  validate(patientValidation.searchPatients),
  patientController.searchPatients,
);

router.post(
  '/',
  requireAuth,
  resolvePractice,
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

/** Not built yet. Mounted now so the app can link to it and the path is final. */
router.get(
  '/:id/history',
  requireAuth,
  resolvePractice,
  requireCan('patient.history'),
  validate(patientValidation.getPatient),
  notImplemented('Patient history'),
);

/** Reports and labs, likewise. */
router.post(
  '/:id/reports',
  requireAuth,
  resolvePractice,
  requireCan('report.create'),
  validate(patientValidation.getPatient),
  notImplemented('Uploading reports'),
);

export default router;
