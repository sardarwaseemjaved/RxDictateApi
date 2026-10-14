import express from 'express';
import { appointmentController } from '../../controllers';
import { appointmentValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolveLocation, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Follow-ups the doctor asked for that nobody has booked yet, derived from
 * approved prescriptions. Location-scoped, because that is where the
 * appointment would be booked.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('appointment.read'),
  validate(appointmentValidation.listFollowUps),
  appointmentController.listFollowUps,
);

export default router;
