import express from 'express';
import { prescriptionController, voiceController } from '../../controllers';
import { prescriptionValidation, voiceValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
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

/**
 * Start a prescription from one of the doctor's own templates (`:id` is the
 * template). When the visit already has an open draft, the template's lines are
 * added to it instead and nothing already there is removed: 200 for that, 201
 * for a new draft.
 */
router.post(
  '/from-template/:id',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.create'),
  validate(prescriptionValidation.createFromTemplate),
  prescriptionController.createFromTemplate,
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

/**
 * Abandon a draft. The way out of a revision somebody thought better of: the
 * version being revised is left approved and untouched.
 */
router.post(
  '/:id/cancel',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.update'),
  validate(prescriptionValidation.cancelPrescription),
  prescriptionController.cancelPrescription,
);

/** Opens version 2 as a draft. Version 1 stays approved until version 2 is signed. */
router.post(
  '/:id/revise',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.revise'),
  validate(prescriptionValidation.revisePrescription),
  prescriptionController.revisePrescription,
);

/**
 * What the page will look like before it is signed. Marked DRAFT and carrying
 * no number, so it cannot be mistaken for the real thing, and read-only
 * permission because looking is not signing.
 */
router.get(
  '/:id/preview',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('prescription.read'),
  validate(prescriptionValidation.previewPrescription),
  prescriptionController.previewPrescription,
);

/** A short-lived signed URL of the approved document. The PA may print it. */
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
