import express from 'express';
import { announcementController } from '../../controllers';
import { announcementValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { PLATFORM_ONLY, resolveLocationIfSent, resolveOrganisation, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Announcements. Each route serves one kind of organisation:
 *
 * - RxDictate's console (the platform) writes, publishes and measures them;
 * - a clinic member sees what is meant for them and acts on it. X-Location-Id
 *   is welcome on the slots: it decides which location's city and province
 *   the audience is matched against.
 *
 * A company reaches none of this in this phase, and a patient never does.
 * The member routes come first, so /slots is never read as an id.
 */
const platform = [requireAuth, resolveOrganisation(PLATFORM_ONLY)];
const member = [requireAuth, resolvePractice, resolveLocationIfSent, requireCan('announcement.view')];

/* A clinic member. */

router.get('/slots', ...member, validate(announcementValidation.slots), announcementController.slots);

router.post('/:id/events', ...member, validate(announcementValidation.recordEvent), announcementController.recordEvent);

router.post('/:id/reminder', ...member, validate(announcementValidation.reminder), announcementController.setReminder);

router.delete('/:id/reminder', ...member, validate(announcementValidation.reminder), announcementController.cancelReminder);

router.post('/:id/register', ...member, validate(announcementValidation.register), announcementController.register);

router.delete('/:id/register', ...member, validate(announcementValidation.unregister), announcementController.unregister);

/* The console. */

router.get(
  '/',
  ...platform,
  requireCan('announcement.read'),
  validate(announcementValidation.listAnnouncements),
  announcementController.listAnnouncements,
);

router.post(
  '/',
  ...platform,
  requireCan('announcement.create'),
  validate(announcementValidation.createAnnouncement),
  announcementController.createAnnouncement,
);

router.post(
  '/images',
  ...platform,
  requireCan('announcement.create'),
  validate(announcementValidation.createImageUpload),
  announcementController.createImageUpload,
);

router.post(
  '/audience-count',
  ...platform,
  requireCan('announcement.read'),
  validate(announcementValidation.audienceCount),
  announcementController.audienceCount,
);

router.get(
  '/products',
  ...platform,
  requireCan('announcement.create'),
  validate(announcementValidation.searchProducts),
  announcementController.searchProducts,
);

router.get(
  '/:id',
  ...platform,
  requireCan('announcement.read'),
  validate(announcementValidation.getAnnouncement),
  announcementController.getAnnouncement,
);

router.patch(
  '/:id',
  ...platform,
  requireCan('announcement.create'),
  validate(announcementValidation.updateAnnouncement),
  announcementController.updateAnnouncement,
);

router.post(
  '/:id/publish',
  ...platform,
  requireCan('announcement.publish'),
  validate(announcementValidation.changeStatus),
  announcementController.publishAnnouncement,
);

router.post(
  '/:id/withdraw',
  ...platform,
  requireCan('announcement.publish'),
  validate(announcementValidation.changeStatus),
  announcementController.withdrawAnnouncement,
);

router.get(
  '/:id/stats',
  ...platform,
  requireCan('announcement.read'),
  validate(announcementValidation.getAnnouncement),
  announcementController.getStats,
);

router.get(
  '/:id/registrations',
  ...platform,
  requireCan('announcement.registrations.read'),
  validate(announcementValidation.listRegistrations),
  announcementController.listRegistrations,
);

router.get(
  '/:id/registrations.csv',
  ...platform,
  requireCan('announcement.registrations.read'),
  validate(announcementValidation.getAnnouncement),
  announcementController.registrationsCsv,
);

export default router;
