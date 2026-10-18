import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import config from '../config/config';
import { AppError } from '../core/errors';

/**
 * Rate limiting is on in every environment.
 *
 * It used to be mounted only when NODE_ENV was production, which meant the one
 * endpoint that spends money on an SMS for every call was wide open on staging.
 */
const limiter = (options: Partial<Options>) =>
  rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError('RATE_LIMITED', 'Too many requests. Please slow down.'));
    },
    ...options,
  });

/** A ceiling for the whole API, generous enough that no honest client notices. */
export const generalLimiter = limiter({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
});

/** Sign-in is brute-forceable by nature, so it gets its own, tighter bucket. */
export const authLimiter = limiter({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.authMax,
  skipSuccessfulRequests: true,
});

/**
 * Keyed on the phone number rather than the IP: an SMS costs money and goes to
 * a real person, so the thing worth protecting is the number being texted, not
 * the connection asking. The per-phone cooldown in the auth service is the
 * other half of this and is the one that survives a restart.
 */
export const otpLimiter = limiter({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.otpMax,
  keyGenerator: (req: Request) => {
    const phone = (req.body as { phone?: unknown } | undefined)?.phone;
    return typeof phone === 'string' && phone.length > 0 ? `phone:${phone}` : `ip:${req.ip ?? 'unknown'}`;
  },
});

/**
 * Signing out is cheap and must stay available - a limiter that refuses it
 * leaves a session open - so this is only here to stop the endpoint being used
 * to probe for live sessions.
 */
export const logoutLimiter = limiter({
  windowMs: 60 * 1000,
  limit: config.rateLimit.logoutMax,
});

export default { generalLimiter, authLimiter, otpLimiter, logoutLimiter };
