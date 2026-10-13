import express from 'express';
import { visitController } from '../../controllers';
import { visitValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolveLocation, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Location-scoped: today's list belongs to a place. resolveLocation holds a PA
 * to the locations she was assigned, while a doctor may name any location of
 * his own practice.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('visit.read'),
  validate(visitValidation.listVisits),
  visitController.listVisits,
);

router.post(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('visit.create'),
  validate(visitValidation.createVisit),
  visitController.createVisit,
);

router.patch(
  '/:id',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('visit.update'),
  validate(visitValidation.updateVisit),
  visitController.updateVisit,
);

export default router;
