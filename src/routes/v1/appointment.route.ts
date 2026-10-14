import express from 'express';
import { appointmentController } from '../../controllers';
import { appointmentValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolveLocation, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Location-scoped like visits: an appointment is a slot at a place, and a PA
 * may only book at the locations she works at.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('appointment.read'),
  validate(appointmentValidation.listAppointments),
  appointmentController.listAppointments,
);

router.post(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('appointment.create'),
  validate(appointmentValidation.createAppointment),
  appointmentController.createAppointment,
);

/** Cancelled, not deleted: the slot frees up and the booking stays on record. */
router.post(
  '/:id/cancel',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('appointment.cancel'),
  validate(appointmentValidation.cancelAppointment),
  appointmentController.cancelAppointment,
);

export default router;
