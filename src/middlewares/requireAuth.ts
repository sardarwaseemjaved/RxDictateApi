import type { RequestHandler } from 'express';
import { User } from '../models';
import { AppError } from '../core/errors';
import catchAsync from '../utils/catchAsync';
import { verifyAccessToken } from '../services/token.service';
import { assertSessionActive } from '../services/session.service';

/**
 * Who an access token belongs to, with every check requireAuth makes and no
 * Express: the realtime handshake runs exactly these.
 *
 * Both halves are checked every time. The token says who and which session;
 * the session says whether that is still true. An access token is a signed
 * claim that cannot be withdrawn, so without the second check a phone that
 * signed out would keep working until its token happened to expire.
 *
 * The user is loaded rather than trusted from the token, so an account deleted
 * between the token being issued and being used does not get through.
 */
export const authenticate = async (token: string): Promise<Express.AuthContext & { expiresAt: Date }> => {
  const { userId, sessionId, expiresAt } = verifyAccessToken(token);
  await assertSessionActive(sessionId);

  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('TOKEN_INVALID', 'Please authenticate');
  }

  return { userId: user._id, sessionId, phone: user.phone, name: user.name, expiresAt };
};

/** Who is calling. Runs on everything except /auth, and sets req.auth. */
const requireAuth: RequestHandler = catchAsync(async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    throw new AppError('UNAUTHENTICATED', 'Please authenticate');
  }

  const { userId, sessionId, phone, name } = await authenticate(header.slice('Bearer '.length));
  req.auth = { userId, sessionId, phone, name };
  next();
});

export default requireAuth;
