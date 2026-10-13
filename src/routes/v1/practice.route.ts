import express from 'express';
import { practiceController } from '../../controllers';
import { practiceValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

router.get('/', requireAuth, resolvePractice, requireCan('practice.read'), practiceController.getPractice);

router.patch(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('practice.update'),
  validate(practiceValidation.updatePractice),
  practiceController.updatePractice,
);

export default router;
