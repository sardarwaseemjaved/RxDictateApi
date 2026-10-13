import express from 'express';
import { locationController } from '../../controllers';
import { locationValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('location.read'),
  validate(locationValidation.listLocations),
  locationController.listLocations,
);

router.post(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('location.create'),
  validate(locationValidation.createLocation),
  locationController.createLocation,
);

router.patch(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('location.update'),
  validate(locationValidation.updateLocation),
  locationController.updateLocation,
);

// Archive, not delete: approved prescriptions point here.
router.post(
  '/:id/archive',
  requireAuth,
  resolvePractice,
  requireCan('location.archive'),
  validate(locationValidation.archiveLocation),
  locationController.archiveLocation,
);

export default router;
