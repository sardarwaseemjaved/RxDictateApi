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
  const { phone, code, name, intent } = req.body as VerifyOtpBody;
  sendData(res, await authService.verifyOtp(phone, code, name, intent));
});

export const refresh = catchAsync(async (req, res) => {
  const { refreshToken } = req.body as RefreshBody;
  sendData(res, await authService.refresh(refreshToken));
});

export const logout = catchAsync(async (req, res) => {
  const { refreshToken } = req.body as LogoutBody;
  await authService.logout(refreshToken);
  sendData(res, { signedOut: true });
});
