import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import config from '../config/config';
import { AppError } from '../core/errors';
import { verifyAccessToken } from '../services/token.service';

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

/**
 * Who a request counts against in the general bucket: the person, when it
 * carries an access token this API signed, otherwise the address.
 *
 * By person because a clinic's reception, its doctor and their phones usually
 * share one connection, and so one IP; counted by address they used up one
 * allowance between them. The token's signature is checked - its expiry is
 * not, since a lapsed token still names who is asking - so nobody gets a fresh
 * allowance by inventing subjects: a token that doesn't verify counts by
 * address. The session isn't looked up; requireAuth does that, after this.
 */
export const generalLimitKey = (req: Request): string => {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (token) {
    try {
      return `user:${verifyAccessToken(token, { allowExpired: true }).userId}`;
    } catch {
      // Not one of ours: counted by address below.
    }
  }
  return `ip:${req.ip ?? 'unknown'}`;
};

/**
 * A ceiling for the whole API, per person when signed in and per address when
 * not, generous enough that no honest client notices. The limit is read per
 * request, so a test can tighten it without reloading the app.
 */
export const generalLimiter = limiter({
  windowMs: config.rateLimit.windowMs,
  limit: () => config.rateLimit.max,
  keyGenerator: generalLimitKey,
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

/**
 * The public verify routes, in their own bucket shared by both. A pharmacist
 * scans a page or two; anything near this many a minute from one address is
 * somebody trying codes in bulk.
 *
 * The limit is read per request, so a test can tighten it without reloading
 * the app.
 */
export const verifyLimiter = limiter({
  windowMs: 60 * 1000,
  limit: () => config.rateLimit.verifyMax,
});

/**
 * The routes that try a code to link a record, in their own bucket shared by
 * both. Keyed on the person rather than the address, because a whole mobile
 * network can sit behind one IP here. Mounted after requireAuth.
 */
export const portalLinkLimiter = limiter({
  windowMs: 60 * 1000,
  limit: () => config.rateLimit.portalLinkMax,
  keyGenerator: (req: Request) => `user:${String(req.auth?.userId)}`,
});

export default { generalLimiter, authLimiter, otpLimiter, logoutLimiter, verifyLimiter, portalLinkLimiter };
