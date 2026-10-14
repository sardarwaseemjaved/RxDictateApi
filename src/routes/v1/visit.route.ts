import express from 'express';
import { visitController, vitalsController } from '../../controllers';
import { visitValidation, vitalsValidation } from '../../validations';
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

/**
 * Vitals belong to a visit, not to a patient: the same person's blood pressure
 * last month is a different reading, and the queue needs to know whether
 * today's has been taken.
 *
 * A PUT because there is exactly one set per visit. visit.update rather than a
 * permission of its own, because taking vitals is the PA's part of running the
 * queue.
 */
router.get(
  '/:id/vitals',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('visit.read'),
  validate(vitalsValidation.getVitals),
  vitalsController.getVitals,
);

router.put(
  '/:id/vitals',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('visit.update'),
  validate(vitalsValidation.recordVitals),
  vitalsController.recordVitals,
);

export default router;
