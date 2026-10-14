import express from 'express';
import { notificationController } from '../../controllers';
import { notificationValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * This person's inbox in this clinic. The rows have been written since the
 * first commit by the event listeners, so there was nothing to backfill.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('notification.read'),
  validate(notificationValidation.listNotifications),
  notificationController.listNotifications,
);

router.post(
  '/read',
  requireAuth,
  resolvePractice,
  requireCan('notification.read'),
  validate(notificationValidation.markRead),
  notificationController.markRead,
);

export default router;
