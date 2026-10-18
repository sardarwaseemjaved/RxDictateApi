import * as authService from '../services/auth.service';
import catchAsync from '../utils/catchAsync';
import { sendData } from '../utils/response';
import type { LogoutBody, RefreshBody, SendOtpBody, VerifyOtpBody } from '../shared/auth.schema';

export const sendOtp = catchAsync(async (req, res) => {
  const { phone } = req.body as SendOtpBody;
  const result = await authService.sendOtp(phone);
  sendData(res, { sent: true, ...result });
});

export const verifyOtp = catchAsync(async (req, res) => {
  const { phone, code, name, intent, deviceId, platform, appVersion } = req.body as VerifyOtpBody;
  sendData(res, await authService.verifyOtp(phone, code, { deviceId, platform, appVersion }, name, intent));
});

export const refresh = catchAsync(async (req, res) => {
  const { refreshToken } = req.body as RefreshBody;
  sendData(res, await authService.refresh(refreshToken));
});

/**
 * No requireAuth on this route: the session is identified from whichever
 * credential the app still has, and signing out must not fail because the
 * access token lapsed a minute ago.
 */
export const logout = catchAsync(async (req, res) => {
  const { refreshToken } = req.body as LogoutBody;
  const header = req.headers.authorization ?? '';
  const accessToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;

  await authService.logout(accessToken, refreshToken, { requestId: req.id ?? null, ip: req.ip ?? null });

  // Always the same answer, so the app has one path out: signed out.
  sendData(res, { signedOut: true });
});
