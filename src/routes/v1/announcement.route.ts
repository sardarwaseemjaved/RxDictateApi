import express from 'express';
import { announcementController } from '../../controllers';
import { announcementValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { PLATFORM_ONLY, resolveLocationIfSent, resolveOrganisation, resolvePractice } from '../../core/tenancy';
import { requireCan, requireCanAny, requireCanFor } from '../../core/permissions';
import { parsedQuery } from '../../utils/request';
import type { ListAnnouncementsQuery } from '../../shared/announcement.schema';

const router = express.Router();

/**
 * Announcements. Each route serves one kind of organisation:
 *
 * - RxDictate's console (the platform) writes, publishes and measures them;
 * - a clinic member sees what is meant for them and acts on it. X-Location-Id
 *   is welcome on the slots: it decides which location's city and province
 *   the audience is matched against;
 * - a company uploads a picture and counts an audience by rule for the one
 *   it sends for review, which it sends at /company/announcements.
 *
 * A patient never reaches any of it. The member routes come first, so /slots
 * is never read as an id; so do /images, /audience-count, /people, /products
 * and /reach.
 */
const platform = [requireAuth, resolveOrganisation(PLATFORM_ONLY)];
const platformOrCompany = [requireAuth, resolveOrganisation(['platform', 'company'])];
const member = [requireAuth, resolvePractice, resolveLocationIfSent, requireCan('announcement.view')];

/* A clinic member. */

router.get('/slots', ...member, validate(announcementValidation.slots), announcementController.slots);

router.post('/:id/events', ...member, validate(announcementValidation.recordEvent), announcementController.recordEvent);

router.post('/:id/reminder', ...member, validate(announcementValidation.reminder), announcementController.setReminder);

router.delete('/:id/reminder', ...member, validate(announcementValidation.reminder), announcementController.cancelReminder);

router.post('/:id/register', ...member, validate(announcementValidation.register), announcementController.register);

router.delete('/:id/register', ...member, validate(announcementValidation.unregister), announcementController.unregister);

/* The console. */

// One person's record of each needs announcement.people.read as well.
router.get(
  '/',
  ...platform,
  requireCan('announcement.read'),
  validate(announcementValidation.listAnnouncements),
  requireCanFor((req) =>
    parsedQuery<ListAnnouncementsQuery>(req).userId ? 'announcement.people.read' : 'announcement.read',
  ),
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
  ...platformOrCompany,
  requireCanAny(['announcement.create', 'announcement.submit']),
  validate(announcementValidation.createImageUpload),
  announcementController.createImageUpload,
);

router.post(
  '/audience-count',
  ...platformOrCompany,
  requireCanAny(['announcement.read', 'announcement.submit']),
  validate(announcementValidation.audienceCount),
  announcementController.audienceCount,
);

router.get(
  '/people',
  ...platform,
  requireCan('announcement.create'),
  validate(announcementValidation.searchPeople),
  announcementController.searchPeople,
);

router.get(
  '/reach',
  ...platform,
  requireCan('announcement.read'),
  requireCan('announcement.people.read'),
  validate(announcementValidation.reach),
  announcementController.reach,
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
