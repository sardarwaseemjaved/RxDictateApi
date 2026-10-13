import express from 'express';
import { authController } from '../../controllers';
import { authValidation } from '../../validations';
import validate from '../../middlewares/validate';
import { authLimiter, otpLimiter } from '../../middlewares/rateLimiter';

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
router.post('/logout', validate(authValidation.logout), authController.logout);

export default router;
