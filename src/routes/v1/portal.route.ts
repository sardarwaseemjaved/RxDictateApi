import express from 'express';
import { portalController } from '../../controllers';
import { portalValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import { portalLinkLimiter } from '../../middlewares/rateLimiter';
import resolvePortalLink from '../../middlewares/resolvePortalLink';
import validate from '../../middlewares/validate';

const router = express.Router();

/**
 * The patient's own area. Sign-in and no X-Practice-Id: a patient is not a
 * member of a clinic, so neither tenancy nor the permissions table has anything
 * to say here, and holding a link opens no clinic route.
 *
 * Trying a code has its own tight bucket. Every record route runs
 * resolvePortalLink, which is the one place access to a record is decided.
 */
router.post('/links/preview', requireAuth, portalLinkLimiter, validate(portalValidation.link), portalController.previewLink);
router.post('/links', requireAuth, portalLinkLimiter, validate(portalValidation.link), portalController.createLink);
router.get('/links', requireAuth, portalController.listLinks);
router.delete('/links/:linkId', requireAuth, validate(portalValidation.oneLink), portalController.removeLink);

const records = express.Router({ mergeParams: true });

records.get('/prescriptions', validate(portalValidation.page), portalController.listPrescriptions);
records.get('/prescriptions/:id', validate(portalValidation.oneRecord), portalController.getPrescription);
records.get('/prescriptions/:id/pdf', validate(portalValidation.oneRecord), portalController.prescriptionPdf);
records.get('/reports', validate(portalValidation.page), portalController.listReports);
records.get('/reports/:id', validate(portalValidation.oneRecord), portalController.getReport);
records.get('/appointments', validate(portalValidation.listAppointments), portalController.listAppointments);
records.get('/follow-ups', validate(portalValidation.page), portalController.listFollowUps);
records.get('/vitals', validate(portalValidation.page), portalController.listVitals);
/** Step one of an upload: somewhere to PUT one page, issued to this link alone. */
records.post('/uploads', validate(portalValidation.createUpload), portalController.createUpload);
/** Step two: lands in the clinic's report inbox, unreviewed, as any report does. */
records.post('/reports', validate(portalValidation.createReport), portalController.createReport);

router.use('/links/:linkId', requireAuth, validate(portalValidation.oneLink), resolvePortalLink, records);

export default router;
