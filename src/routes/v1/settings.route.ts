import express from 'express';
import { settingsController } from '../../controllers';
import { settingsValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { ANY_ORGANISATION, resolveOrganisation } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Settings, for a member of any kind of organisation: a clinic's doctor and
 * assistants, and the platform's staff. X-Practice-Id says which membership
 * is asking.
 *
 * What a layer may set is the registry's to say (src/shared/settings.ts), and
 * the validation refuses the rest. Your own values need nothing beyond
 * settings.read: the registry decides which settings a person may choose.
 */
router.get(
  '/',
  requireAuth,
  resolveOrganisation(ANY_ORGANISATION),
  requireCan('settings.read'),
  settingsController.getSettings,
);

router.patch(
  '/me',
  requireAuth,
  resolveOrganisation(ANY_ORGANISATION),
  requireCan('settings.read'),
  validate(settingsValidation.updateMySettings),
  settingsController.updateMySettings,
);

router.patch(
  '/organisation',
  requireAuth,
  resolveOrganisation(ANY_ORGANISATION),
  requireCan('settings.organisation.update'),
  validate(settingsValidation.updateOrganisationSettings),
  settingsController.updateOrganisationSettings,
);

router.patch(
  '/platform',
  requireAuth,
  resolveOrganisation(ANY_ORGANISATION),
  requireCan('settings.platform.update'),
  validate(settingsValidation.updatePlatformSettings),
  settingsController.updatePlatformSettings,
);

export default router;
