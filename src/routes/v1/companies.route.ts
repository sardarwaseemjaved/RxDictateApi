import express from 'express';
import { companyController } from '../../controllers';
import { companyValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { PLATFORM_ONLY, resolveOrganisation } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Medicine companies, for RxDictate's own console only: every route here
 * serves the platform organisation and nothing else. A company reads its own
 * profile at GET /company.
 */
const platform = [requireAuth, resolveOrganisation(PLATFORM_ONLY)];

router.get(
  '/',
  ...platform,
  requireCan('company.read'),
  validate(companyValidation.listCompanies),
  companyController.listCompanies,
);

router.post(
  '/',
  ...platform,
  requireCan('company.create'),
  validate(companyValidation.createCompany),
  companyController.createCompany,
);

router.get(
  '/:id',
  ...platform,
  requireCan('company.read'),
  validate(companyValidation.getCompany),
  companyController.getCompany,
);

router.patch(
  '/:id',
  ...platform,
  requireCan('company.update'),
  validate(companyValidation.updateCompany),
  companyController.updateCompany,
);

router.post(
  '/:id/suspend',
  ...platform,
  requireCan('company.suspend'),
  validate(companyValidation.changeStatus),
  companyController.suspendCompany,
);

router.post(
  '/:id/reactivate',
  ...platform,
  requireCan('company.suspend'),
  validate(companyValidation.changeStatus),
  companyController.reactivateCompany,
);

export default router;
