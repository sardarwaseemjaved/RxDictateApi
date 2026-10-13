import express from 'express';
import requireAuth from '../../middlewares/requireAuth';
import notImplemented from '../../middlewares/notImplemented';
import { resolveLocation, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

// An appointment belongs to a place and a time, so it is location-scoped like a
// visit.
router.get(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('appointment.read'),
  notImplemented('Appointments'),
);
router.post(
  '/',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('appointment.create'),
  notImplemented('Appointments'),
);

export default router;
