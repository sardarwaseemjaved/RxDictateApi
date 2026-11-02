import * as verifyService from '../services/verify.service';
import catchAsync from '../utils/catchAsync';
import { sendData } from '../utils/response';

export const getVerification = catchAsync(async (req, res) => {
  sendData(res, await verifyService.getVerification(req.params.code));
});

/**
 * The QR image. A code never changes what it points at, so it is cached for a
 * year by anyone. Cross-origin, because the web app shows it in an <img> from
 * its own origin and helmet would otherwise answer same-origin.
 */
export const getQr = catchAsync(async (req, res) => {
  const svg = await verifyService.verificationQr(req.params.code);
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(svg);
});
