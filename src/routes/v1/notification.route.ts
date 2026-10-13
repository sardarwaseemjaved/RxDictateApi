import express from 'express';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import notImplemented from '../../middlewares/notImplemented';
import { notificationValidation } from '../../validations';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Notifications are already being written by the event listeners; there is just
 * no inbox yet. These answer 501 behind the real auth and permission chain, so
 * the day the screen ships nothing about the contract changes.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('notification.read'),
  validate(notificationValidation.listNotifications),
  notImplemented('The notification inbox'),
);

router.post(
  '/read',
  requireAuth,
  resolvePractice,
  requireCan('notification.read'),
  validate(notificationValidation.markRead),
  notImplemented('Marking notifications read'),
);

export default router;
