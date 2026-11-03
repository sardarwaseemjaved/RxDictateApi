import {
  updateOrganisationSettingsBodySchema,
  updatePlatformSettingsBodySchema,
  updateUserSettingsBodySchema,
} from '../shared/settings';

export const updateMySettings = { body: updateUserSettingsBodySchema };
export const updateOrganisationSettings = { body: updateOrganisationSettingsBodySchema };
export const updatePlatformSettings = { body: updatePlatformSettingsBodySchema };
