import express from 'express';
import { templateController } from '../../controllers';
import { templateValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * The doctor's own templates. Practice-scoped and not location-scoped: a
 * template is how this doctor prescribes, wherever they are sitting.
 *
 * Every read and write is held to the calling doctor's templates, so another
 * doctor's template in the same clinic is a 404 here. Starting a prescription
 * from one is POST /prescriptions/from-template/:id.
 *
 * `practice.features.templates` is not checked: neither app reads it, and
 * honouring its default of false would switch this off for every clinic.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('template.read'),
  validate(templateValidation.listTemplates),
  templateController.listTemplates,
);

/** From sections, or "Save as template" with `fromPrescriptionId`. */
router.post(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('template.create'),
  validate(templateValidation.createTemplate),
  templateController.createTemplate,
);

router.get(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('template.read'),
  validate(templateValidation.getTemplate),
  templateController.getTemplate,
);

router.patch(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('template.update'),
  validate(templateValidation.updateTemplate),
  templateController.updateTemplate,
);

/** Soft delete. Answers with the template as it was. */
router.delete(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('template.delete'),
  validate(templateValidation.deleteTemplate),
  templateController.deleteTemplate,
);

export default router;
