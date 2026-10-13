import type { Types } from 'mongoose';
import { User } from '../models';
import { AppError } from '../core/errors';
import type { MeView, UpdateMeBody } from '../shared/me.schema';
import { membershipViews } from './auth.service';

/**
 * The one call the app makes on launch: who am I, and which clinics and
 * locations can I work at. Needs no X-Practice-Id, because its answer is what
 * tells the app which practice ids exist.
 */
export const getMe = async (userId: Types.ObjectId): Promise<MeView> => {
  const user = await User.findById(userId);
  if (!user) {
    throw AppError.notFound('User');
  }

  return {
    id: String(user._id),
    phone: user.phone,
    name: user.name,
    lastLoginAt: user.lastLoginAt,
    memberships: await membershipViews(user._id),
  };
};

export const updateMe = async (userId: Types.ObjectId, patch: UpdateMeBody): Promise<MeView> => {
  const user = await User.findById(userId);
  if (!user) {
    throw AppError.notFound('User');
  }
  if (patch.name !== undefined) {
    user.name = patch.name;
  }
  await user.save();
  return getMe(userId);
};

export default { getMe, updateMe };
