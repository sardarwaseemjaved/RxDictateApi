import express from 'express';
import { authController } from '../../controllers';
import { authValidation } from '../../validations';
import validate from '../../middlewares/validate';
import { authLimiter, logoutLimiter, otpLimiter } from '../../middlewares/rateLimiter';
import requireAuth from '../../middlewares/requireAuth';
import notImplemented from '../../middlewares/notImplemented';

const router = express.Router();

/**
 * The only routes that need neither a token nor X-Practice-Id.
 *
 * Sending a code costs money and reaches a real person, so it carries a second
 * limiter keyed on the phone number rather than the connection. The cooldown in
 * the auth service is the half of that which survives a restart.
 */
router.post('/otp/send', otpLimiter, validate(authValidation.sendOtp), authController.sendOtp);
router.post('/otp/verify', authLimiter, validate(authValidation.verifyOtp), authController.verifyOtp);
router.post('/refresh', authLimiter, validate(authValidation.refresh), authController.refresh);
/**
 * No requireAuth: the session is identified from the access token even when it
 * has expired, or from the refresh token in the body. Signing out is
 * idempotent and always answers the same way, so the app has one path out.
 */
router.post('/logout', logoutLimiter, validate(authValidation.logout), authController.logout);

/**
 * Not built yet. Mounted now so the path, the validation and the auth chain
 * are settled, and the app can link to it.
 */
router.post(
  '/logout-all',
  requireAuth,
  logoutLimiter,
  validate(authValidation.logoutAll),
  notImplemented('Signing out of every device'),
);

export default router;
