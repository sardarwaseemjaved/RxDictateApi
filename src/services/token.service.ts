import { createHash, randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config/config';
import { RefreshToken, type RefreshTokenDoc, type UserDoc } from '../models';
import { AppError } from '../core/errors';
import { addDays, addMinutes } from '../utils/time';
import type { TokenPair } from '../shared/auth.schema';

type TokenType = 'access' | 'refresh';

interface Claims {
  sub: string;
  type: TokenType;
  /**
   * A nonce, because `iat` has one-second resolution: without it two tokens
   * signed for the same user in the same second are byte-identical, and a
   * refresh token that is supposed to be single use would be reissued
   * unchanged.
   */
  jti: string;
}

/**
 * Unsalted, because a lookup has to find the row from the token alone. What
 * makes that safe is that the token is a signed JWT rather than a password:
 * there is nothing to guess and no dictionary to run.
 */
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');

const sign = (userId: string, type: TokenType, expires: Date): string =>
  jwt.sign({ sub: userId, type, jti: randomUUID() } satisfies Claims, config.jwt.secret, {
    expiresIn: Math.floor((expires.getTime() - Date.now()) / 1000),
  });

/**
 * Verify an access token and return who it belongs to.
 *
 * The `type` claim is what stops a refresh token being presented as an access
 * token: both are signed with the same key, and only the claim tells them
 * apart.
 */
export const verifyAccessToken = (token: string): string => {
  const payload = jwt.verify(token, config.jwt.secret) as Partial<Claims>;
  if (payload.type !== 'access' || !payload.sub) {
    throw new AppError('TOKEN_INVALID', 'Please authenticate');
  }
  return payload.sub;
};

export const generateAuthTokens = async (user: UserDoc): Promise<TokenPair> => {
  const accessExpires = addMinutes(new Date(), config.jwt.accessExpirationMinutes);
  const refreshExpires = addDays(new Date(), config.jwt.refreshExpirationDays);

  const access = sign(String(user._id), 'access', accessExpires);
  const refresh = sign(String(user._id), 'refresh', refreshExpires);

  await RefreshToken.create({
    tokenHash: hash(refresh),
    userId: user._id,
    expires: refreshExpires,
  });

  return {
    access: { token: access, expires: accessExpires },
    refresh: { token: refresh, expires: refreshExpires },
  };
};

/**
 * Check a refresh token and burn it in the same step, so it is single use: a
 * refresh that is replayed, by the app or by somebody who stole it, fails.
 */
export const consumeRefreshToken = async (token: string): Promise<RefreshTokenDoc> => {
  let payload: Partial<Claims>;
  try {
    payload = jwt.verify(token, config.jwt.secret) as Partial<Claims>;
  } catch {
    throw new AppError('TOKEN_INVALID', 'Please sign in again');
  }
  if (payload.type !== 'refresh' || !payload.sub) {
    throw new AppError('TOKEN_INVALID', 'Please sign in again');
  }

  const stored = await RefreshToken.findOneAndDelete({
    tokenHash: hash(token),
    userId: payload.sub,
    blacklisted: false,
  });
  if (!stored) {
    throw new AppError('TOKEN_INVALID', 'Please sign in again');
  }
  return stored;
};

export const revokeRefreshToken = async (token: string): Promise<void> => {
  await RefreshToken.deleteOne({ tokenHash: hash(token) });
};

/** Used when a member is removed: her sessions end with her membership. */
export const revokeAllForUser = async (userId: UserDoc['_id']): Promise<void> => {
  await RefreshToken.deleteMany({ userId });
};

export default { verifyAccessToken, generateAuthTokens, consumeRefreshToken, revokeRefreshToken, revokeAllForUser };
