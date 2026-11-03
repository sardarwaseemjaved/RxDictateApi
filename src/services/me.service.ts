import type { Types } from 'mongoose';
import { Membership, User } from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { allowedLocationsFor } from '../core/tenancy';
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
    specialties: user.specialties,
    memberships: await membershipViews(user._id),
  };
};

/**
 * The person's own details: their name, and what they practise.
 *
 * A person belongs to no single clinic, so the change is audited in every
 * organisation they are active in - the way a sign-in is - and each one's
 * trail has it.
 */
export const updateMe = async (userId: Types.ObjectId, patch: UpdateMeBody): Promise<MeView> => {
  const user = await User.findById(userId);
  if (!user) {
    throw AppError.notFound('User');
  }
  const before = { name: user.name, specialties: [...user.specialties] };

  if (patch.name !== undefined) {
    user.name = patch.name;
  }
  if (patch.specialties !== undefined) {
    user.specialties = patch.specialties;
  }
  await user.save();

  const after = { name: user.name, specialties: [...user.specialties] };
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const memberships = await Membership.find({ userId: user._id, status: 'active' });
    await Promise.all(
      memberships.map((membership) =>
        writeAudit(
          {
            practiceId: membership.practiceId,
            actorId: user._id,
            role: membership.role,
            allowedLocationIds: allowedLocationsFor(membership.role, membership.locationIds),
          },
          { action: 'user.update', entity: 'user', entityId: user._id, before, after },
        ),
      ),
    );
  }

  return getMe(userId);
};

export default { getMe, updateMe };
