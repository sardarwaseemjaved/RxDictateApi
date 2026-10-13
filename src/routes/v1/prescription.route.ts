import express from 'express';
import { prescriptionController, voiceController } from '../../controllers';
import { prescriptionValidation, voiceValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import notImplemented from '../../middlewares/notImplemented';
import { resolveLocation, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

router.get(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.read'),
  validate(prescriptionValidation.listPrescriptions),
  prescriptionController.listPrescriptions,
);

router.post(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.create'),
  validate(prescriptionValidation.createPrescription),
  prescriptionController.createPrescription,
);

/** Started from a template. Not built yet; the path is. */
router.post(
  '/from-template/:id',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.create'),
  validate(prescriptionValidation.getPrescription),
  notImplemented('Starting a prescription from a template'),
);

router.get(
  '/:id',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.read'),
  validate(prescriptionValidation.getPrescription),
  prescriptionController.getPrescription,
);

/**
 * A typed edit, expressed as the same ops a dictation produces. Only a draft
 * accepts one; an approved prescription answers RX_LOCKED.
 */
router.patch(
  '/:id',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.update'),
  validate(prescriptionValidation.patchPrescription),
  prescriptionController.patchPrescription,
);

router.post(
  '/:id/approve',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.approve'),
  validate(prescriptionValidation.approvePrescription),
  prescriptionController.approvePrescription,
);

/** Makes version 2 and supersedes version 1. */
router.post(
  '/:id/revise',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.revise'),
  validate(prescriptionValidation.revisePrescription),
  prescriptionController.revisePrescription,
);

/** A short-lived signed URL. The PA may print, which is most of why she is here. */
router.get(
  '/:id/pdf',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.print'),
  validate(prescriptionValidation.prescriptionPdf),
  prescriptionController.prescriptionPdf,
);

/* ---- dictation, which hangs off a prescription draft ---- */

router.post(
  '/:id/voice/segments',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('voice.dictate'),
  validate(voiceValidation.addSegment),
  voiceController.addSegment,
);

router.get(
  '/:id/voice',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('voice.read'),
  validate(voiceValidation.getVoiceSession),
  voiceController.getVoiceSession,
);

export default router;
