import type { Types } from 'mongoose';
import config from '../config/config';
import logger from '../config/logger';
import { Device, Session, type SessionDoc, type SessionRevokedReason, type UserDoc } from '../models';
import { AppError } from '../core/errors';
import { emit } from '../core/events';
import type { DeviceInfo, TokenPair } from '../shared/auth.schema';
import { addDays } from '../utils/time';
import { familyOf, hashToken, newRefreshToken, newTokenFamily, signAccessToken, verifyAccessToken } from './token.service';

/* ------------------------------------------------------------------ *
 * Is this session still live?
 * ------------------------------------------------------------------ */

/**
 * A short-lived answer to "is this session still live", so that checking it on
 * every request does not mean a database read on every request.
 *
 * In process rather than in Redis: there is one API process today, and the
 * behaviour either way is the same - a signed-out phone keeps working for at
 * most this long. Moving it to Redis when there are several processes is a
 * change to these three functions and to nothing that calls them.
 *
 * Revoking writes through immediately, so the phone that just signed out is
 * refused on its very next request; only the other processes that do not exist
 * yet would see the delay.
 */
const liveUntil = new Map<string, number>();

const cacheSeconds = () => config.session.cacheSeconds;

export const forgetSession = (sessionId: string): void => {
  liveUntil.delete(sessionId);
};

/** Only for tests, which must not inherit a cached answer from another file. */
export const clearSessionCache = (): void => {
  liveUntil.clear();
};

/**
 * Throws unless the session behind an access token is still usable.
 *
 * A missing session is treated as revoked rather than as not found: from the
 * app's side they mean the same thing - sign out locally - and saying which
 * tells an attacker whether a session id was ever real.
 */
export const assertSessionActive = async (sessionId: string): Promise<void> => {
  const cached = liveUntil.get(sessionId);
  if (cached !== undefined && cached > Date.now()) {
    return;
  }

  const session = await Session.findById(sessionId);
  const now = Date.now();

  if (!session || session.revokedAt !== null) {
    liveUntil.delete(sessionId);
    throw new AppError('SESSION_REVOKED', 'You have been signed out. Please sign in again.');
  }
  if (session.expiresAt.getTime() <= now) {
    liveUntil.delete(sessionId);
    throw new AppError('SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  }

  // Never cached past the session's own expiry.
  liveUntil.set(sessionId, Math.min(now + cacheSeconds() * 1000, session.expiresAt.getTime()));
};

/* ------------------------------------------------------------------ *
 * Starting, rotating, ending
 * ------------------------------------------------------------------ */

const tokensFor = (session: SessionDoc, refreshToken: string): TokenPair => {
  const access = signAccessToken(String(session.userId), String(session._id));
  return {
    access: { token: access.token, expires: access.expires },
    refresh: { token: refreshToken, expires: session.expiresAt },
  };
};

/**
 * End a session and say why.
 *
 * Idempotent: a session that is already revoked is left exactly as it was,
 * with its original reason, because the first answer is the true one and
 * signing out twice is not an error.
 */
export const revokeSession = async (session: SessionDoc, reason: SessionRevokedReason): Promise<{ revoked: boolean }> => {
  forgetSession(String(session._id));

  if (session.revokedAt !== null) {
    return { revoked: false };
  }

  // Conditional, so two simultaneous sign-outs do not both claim to be first.
  const updated = await Session.findOneAndUpdate(
    { _id: session._id, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
    { new: true },
  );
  if (!updated) {
    return { revoked: false };
  }

  emit('session.revoked', { userId: updated.userId, sessionId: updated._id, reason });
  return { revoked: true };
};

/**
 * Sign in on a device.
 *
 * Any session this phone already had is retired first, so one phone holds one
 * session: otherwise signing in again would leave the previous one live and
 * un-signed-out-of, which is exactly the thing this collection exists to stop.
 */
export const startSession = async (
  user: UserDoc,
  device: DeviceInfo,
): Promise<{ session: SessionDoc; tokens: TokenPair }> => {
  const existing = await Session.find({ userId: user._id, deviceId: device.deviceId, revokedAt: null });
  await Promise.all(existing.map((session) => revokeSession(session, 'logout')));

  const family = newTokenFamily();
  const refreshToken = newRefreshToken(family);
  const session = await Session.create({
    userId: user._id,
    deviceId: device.deviceId,
    platform: device.platform,
    appVersion: device.appVersion,
    refreshTokenHash: hashToken(refreshToken),
    refreshTokenFamily: family,
    lastUsedAt: new Date(),
    expiresAt: addDays(new Date(), config.session.expirationDays),
  });

  return { session, tokens: tokensFor(session, refreshToken) };
};

/**
 * Exchange a refresh token for a new pair.
 *
 * The token is replaced every time, so a token that comes back a second time
 * is either a replay or a copy - and since the real phone will have moved on,
 * there is no way to tell which holder is the owner. The session is ended
 * rather than guessed about.
 *
 * A token that matches nothing is the same story one rotation later, so it
 * gets the same answer.
 */
export const rotateSession = async (refreshToken: string): Promise<{ session: SessionDoc; tokens: TokenPair }> => {
  const session = await Session.findOne({ refreshTokenHash: hashToken(refreshToken) });

  /**
   * A token that is not the current one, but does name a live family, is a
   * token from this session one or more rotations ago. The real phone has
   * moved on, so somebody else is holding a copy - and there is no way to tell
   * which of the two is the owner. The session ends rather than being guessed
   * about, which also takes the newer token down with it.
   */
  if (!session) {
    const family = familyOf(refreshToken);
    const live = family ? await Session.findOne({ refreshTokenFamily: family, revokedAt: null }) : null;
    if (live) {
      await revokeSession(live, 'reuse_detected');
    }
    throw new AppError('SESSION_REVOKED', 'You have been signed out. Please sign in again.');
  }

  if (session.revokedAt !== null) {
    // Already ended. The first reason stands.
    throw new AppError('SESSION_REVOKED', 'You have been signed out. Please sign in again.');
  }

  const now = new Date();
  if (session.expiresAt.getTime() <= now.getTime()) {
    await revokeSession(session, 'expired');
    throw new AppError('SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  }

  const next = newRefreshToken(session.refreshTokenFamily);
  /**
   * The slide is capped from createdAt, so a phone that refreshes every day
   * cannot keep one sign-in alive forever. Past the cap the session simply
   * ends and the doctor signs in again.
   */
  const hardLimit = addDays(session.createdAt, config.session.maxDays);
  const slid = addDays(now, config.session.expirationDays);

  const rotated = await Session.findOneAndUpdate(
    // Conditional on the hash we read, so two refreshes racing cannot both
    // win and leave one holder with a token that was never stored.
    { _id: session._id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
    {
      $set: {
        refreshTokenHash: hashToken(next),
        lastUsedAt: now,
        expiresAt: slid < hardLimit ? slid : hardLimit,
      },
    },
    { new: true },
  );

  if (!rotated) {
    // Somebody else rotated this exact token between the read and the write.
    await revokeSession(session, 'reuse_detected');
    throw new AppError('SESSION_REVOKED', 'You have been signed out. Please sign in again.');
  }

  forgetSession(String(rotated._id));
  return { session: rotated, tokens: tokensFor(rotated, next) };
};

/**
 * The session this request belongs to, from either credential.
 *
 * An access token that is merely expired still identifies its session, which
 * is what lets a phone sign out cleanly after being asleep. Returns null
 * rather than throwing: signing out must never fail in a way the app has to
 * handle.
 */
export const identifySession = async (
  accessToken: string | undefined,
  refreshToken: string | undefined,
): Promise<SessionDoc | null> => {
  if (accessToken) {
    try {
      const { sessionId } = verifyAccessToken(accessToken, { allowExpired: true });
      const session = await Session.findById(sessionId);
      if (session) {
        return session;
      }
    } catch {
      // Not a token we signed. Fall through to the refresh token.
    }
  }

  if (refreshToken) {
    return Session.findOne({ refreshTokenHash: hashToken(refreshToken) });
  }
  return null;
};

/** Clear this phone's push token. The collection may be empty; that is fine. */
export const forgetDevice = async (userId: Types.ObjectId, deviceId: string): Promise<void> => {
  try {
    await Device.deleteMany({ userId, deviceId });
  } catch (error) {
    // A push token left behind is not a reason to fail a sign-out.
    logger.warn(`could not clear the device record on sign-out: ${(error as Error).message}`);
  }
};

/** Every live session for a person. Behind POST /auth/logout-all, which is not built yet. */
export const revokeAllForUser = async (
  userId: Types.ObjectId,
  reason: SessionRevokedReason,
  exceptSessionId?: Types.ObjectId | string,
): Promise<number> => {
  const sessions = await Session.find({ userId, revokedAt: null });
  const results = await Promise.all(
    sessions
      .filter((session) => !exceptSessionId || String(session._id) !== String(exceptSessionId))
      .map((session) => revokeSession(session, reason)),
  );
  return results.filter((result) => result.revoked).length;
};

/**
 * Retire sessions whose time is up.
 *
 * The TTL index deletes the row a month later; this is what makes it read as
 * revoked in the meantime, so a session is never silently usable past its
 * expiry just because nobody asked.
 */
export const markExpiredSessions = async (now: Date = new Date()): Promise<number> => {
  const due = await Session.find({ revokedAt: null, expiresAt: { $lte: now } });
  const results = await Promise.all(due.map((session) => revokeSession(session, 'expired')));

  const count = results.filter((result) => result.revoked).length;
  if (count > 0) {
    logger.info(`retired ${count} expired session(s)`);
  }
  return count;
};

export default {
  assertSessionActive,
  startSession,
  rotateSession,
  revokeSession,
  identifySession,
  forgetDevice,
  forgetSession,
  clearSessionCache,
  revokeAllForUser,
  markExpiredSessions,
};
