import { createHash, randomBytes, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config/config';
import { AppError } from '../core/errors';
import { addMinutes } from '../utils/time';

/**
 * Signing and checking credentials. No database: the session record that gives
 * these meaning lives in session.service, and keeping the crypto separate is
 * what lets that service be read without reading this one.
 */
interface AccessClaims {
  sub: string;
  sid: string;
  type: 'access';
}

export interface AccessToken {
  token: string;
  expires: Date;
}

export interface VerifiedAccess {
  userId: string;
  sessionId: string;
}

/**
 * The access token carries who and which session, and nothing else.
 *
 * No role and no practice: both are resolved per request from memberships, so
 * removing a PA takes effect on her next request rather than whenever her
 * token happens to expire.
 */
export const signAccessToken = (userId: string, sessionId: string): AccessToken => {
  const expires = addMinutes(new Date(), config.jwt.accessExpirationMinutes);
  const token = jwt.sign({ sub: userId, sid: sessionId, type: 'access' } satisfies AccessClaims, config.jwt.secret, {
    expiresIn: Math.floor((expires.getTime() - Date.now()) / 1000),
  });
  return { token, expires };
};

/**
 * Check an access token.
 *
 * `allowExpired` is for signing out: a doctor whose token lapsed while the app
 * was backgrounded should still be able to end the session cleanly rather than
 * leaving a live one behind on the server. Expiry is reported separately from
 * invalidity, because the app's answer differs - refresh and retry, against
 * sign out.
 */
export const verifyAccessToken = (token: string, { allowExpired = false } = {}): VerifiedAccess => {
  let payload: Partial<AccessClaims>;
  try {
    payload = jwt.verify(token, config.jwt.secret, { ignoreExpiration: allowExpired }) as Partial<AccessClaims>;
  } catch (error) {
    if (error instanceof Error && error.name === 'TokenExpiredError') {
      throw new AppError('TOKEN_EXPIRED', 'Your session needs refreshing.');
    }
    throw new AppError('TOKEN_INVALID', 'Please authenticate');
  }

  if (payload.type !== 'access' || !payload.sub || !payload.sid) {
    throw new AppError('TOKEN_INVALID', 'Please authenticate');
  }
  return { userId: payload.sub, sessionId: payload.sid };
};

/**
 * The refresh token is 32 random bytes rather than a signed claim: it is only
 * ever looked up by hash against a session, so there is nothing for a
 * signature to add, and an opaque string cannot be mistaken for an access
 * token or read if it leaks into a log.
 *
 * It carries its family in front of the random part. Only the current token's
 * hash is stored, so a retired one matches nothing - and without the family
 * there would be no way to tell "a token from this session, one rotation ago"
 * from "a string somebody made up". That difference is the whole of reuse
 * detection: the first means two holders and the session has to go.
 *
 * The family is not a secret and protects nothing; the 32 random bytes after
 * it do.
 */
export const newRefreshToken = (family: string): string => `${family}.${randomBytes(32).toString('base64url')}`;

/** The family a refresh token belongs to, or null if it is not one of ours. */
export const familyOf = (token: string): string | null => {
  const [family, secret] = token.split('.');
  return family && secret ? family : null;
};

/**
 * Unsalted, because a lookup has to find the session from the token alone.
 * What makes that safe is that the token is 256 bits of random: there is
 * nothing to guess and no dictionary to run.
 */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** A new family, started when a session is created and kept across its rotations. */
export const newTokenFamily = (): string => randomUUID();

export default { signAccessToken, verifyAccessToken, newRefreshToken, hashToken, newTokenFamily };
