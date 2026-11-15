import express from 'express';
import { companyController } from '../../controllers';
import { companyValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { COMPANY_ONLY, resolveOrganisation } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * A company's own portal: its profile, its products and its announcements. Every route serves a
 * company and nothing else, so X-Practice-Id is the company's id, and a
 * suspended company's members are refused by the same check.
 *
 * Nothing here changes what a doctor sees. A new product, a change, a
 * discontinuation or a claim is a submission, and goes live only when a
 * reviewer approves it. Each answers 201 with that submission, as
 * GET /submissions/:id shows it.
 */
const company = [requireAuth, resolveOrganisation(COMPANY_ONLY)];

router.get('/', ...company, requireCan('company.profile.read'), companyController.getOwnCompany);

router.get(
  '/products',
  ...company,
  requireCan('drug.submit'),
  validate(companyValidation.listProducts),
  companyController.listProducts,
);

router.post(
  '/products',
  ...company,
  requireCan('drug.submit'),
  validate(companyValidation.createProduct),
  companyController.createProduct,
);

router.post(
  '/products/claim',
  ...company,
  requireCan('drug.submit'),
  validate(companyValidation.claimProduct),
  companyController.claimProduct,
);

// The file's text in the JSON body: 500 rows are far under the API's JSON limit.
router.post(
  '/products/csv/check',
  ...company,
  requireCan('drug.submit'),
  validate(companyValidation.csv),
  companyController.checkCsv,
);

router.post(
  '/products/csv',
  ...company,
  requireCan('drug.submit'),
  validate(companyValidation.csv),
  companyController.sendCsv,
);

router.patch(
  '/products/:id',
  ...company,
  requireCan('drug.submit'),
  validate(companyValidation.updateProduct),
  companyController.updateProduct,
);

router.post(
  '/products/:id/discontinue',
  ...company,
  requireCan('drug.submit'),
  validate(companyValidation.discontinueProduct),
  companyController.discontinueProduct,
);

/*
 * Announcements: one sent for review answers 201 with its submission. The
 * list is every announcement the company sponsors, whoever wrote it, with
 * totals only; registrations are for its own seminars and events. Images and
 * the audience count are at /announcements/images and
 * /announcements/audience-count, shared with the console.
 */
router.get(
  '/announcements',
  ...company,
  requireCan('announcement.submit'),
  validate(companyValidation.listAnnouncements),
  companyController.listAnnouncements,
);

router.post(
  '/announcements',
  ...company,
  requireCan('announcement.submit'),
  validate(companyValidation.submitAnnouncement),
  companyController.submitAnnouncement,
);

router.get(
  '/announcements/:id/registrations',
  ...company,
  requireCan('announcement.submit'),
  validate(companyValidation.listAnnouncementRegistrations),
  companyController.listAnnouncementRegistrations,
);

router.get(
  '/announcements/:id/registrations.csv',
  ...company,
  requireCan('announcement.submit'),
  validate(companyValidation.announcementRegistrationsCsv),
  companyController.announcementRegistrationsCsv,
);

export default router;
