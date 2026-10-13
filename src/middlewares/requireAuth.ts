import type { RequestHandler } from 'express';
import { User } from '../models';
import { AppError } from '../core/errors';
import catchAsync from '../utils/catchAsync';
import { verifyAccessToken } from '../services/token.service';

/**
 * Who is calling. Runs on everything except /auth, and sets req.auth.
 *
 * The user is loaded rather than trusted from the token, so an account that was
 * deleted between the token being issued and being used does not get through.
 */
const requireAuth: RequestHandler = catchAsync(async (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    throw new AppError('UNAUTHENTICATED', 'Please authenticate');
  }

  const userId = verifyAccessToken(header.slice('Bearer '.length));
  const user = await User.findById(userId);
  if (!user) {
    throw new AppError('TOKEN_INVALID', 'Please authenticate');
  }

  req.auth = { userId: user._id, phone: user.phone, name: user.name };
  next();
});

export default requireAuth;
