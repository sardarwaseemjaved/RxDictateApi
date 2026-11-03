import { auditScope } from '../core/audit';
import { scopeFrom } from '../core/tenancy';
import * as settingsService from '../services/settings.service';
import catchAsync from '../utils/catchAsync';
import { sendData } from '../utils/response';
import type { SettingsPatch } from '../shared/settings';

export const getSettings = catchAsync(async (req, res) => {
  sendData(res, await settingsService.getSettings(scopeFrom(req)));
});

export const updateMySettings = catchAsync(async (req, res) => {
  sendData(res, await settingsService.updateUserSettings(auditScope(req), req.body as SettingsPatch));
});

export const updateOrganisationSettings = catchAsync(async (req, res) => {
  sendData(res, await settingsService.updateOrganisationSettings(auditScope(req), req.body as SettingsPatch));
});

export const updatePlatformSettings = catchAsync(async (req, res) => {
  sendData(res, await settingsService.updatePlatformSettings(auditScope(req), req.body as SettingsPatch));
});
