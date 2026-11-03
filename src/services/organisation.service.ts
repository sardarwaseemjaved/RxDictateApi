import type { Types } from 'mongoose';
import { Membership, Practice, User, type PracticeDoc, type UserDoc } from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import type { Scope } from '../core/db';
import { phoneSchema } from '../shared/common';

/** What the platform organisation is called where a name is shown: GET /me's practiceName. */
export const PLATFORM_NAME = 'RxDictate';

/**
 * Every practice made before organisations had types is a clinic. Mongoose
 * already reads a missing type as 'clinic'; this writes it down, so a query
 * by type finds them too. Idempotent, and run on boot.
 */
export const backfillOrganisationTypes = async (): Promise<number> => {
  const result = await Practice.updateMany({ type: null }, { $set: { type: 'clinic' } });
  return result.modifiedCount;
};

export interface PlatformInitResult {
  organisationId: Types.ObjectId;
  userId: Types.ObjectId;
  createdOrganisation: boolean;
  createdUser: boolean;
  /** False when this phone was already an active platform admin, and nothing was written. */
  grantedAdmin: boolean;
}

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number }).code === 11000;

/**
 * The platform, made once. A unique index allows only one, so two runs at the
 * same moment end with the one the first made.
 */
const thePlatform = async (owner: UserDoc): Promise<{ platform: PracticeDoc; created: boolean }> => {
  const existing = await Practice.findOne({ type: 'platform' });
  if (existing) {
    return { platform: existing, created: false };
  }
  try {
    const platform = await Practice.create({
      type: 'platform',
      name: PLATFORM_NAME,
      ownerId: owner._id,
      createdBy: owner._id,
    });
    return { platform, created: true };
  } catch (error) {
    const made = isDuplicateKey(error) ? await Practice.findOne({ type: 'platform' }) : null;
    if (!made) {
      throw error;
    }
    return { platform: made, created: false };
  }
};

/**
 * `yarn platform:init --phone +92...`: make the platform organisation if
 * there is none, and make this phone a platform admin in it, creating the
 * user if nobody has signed in with it yet.
 *
 * The only way the first platform admin comes to exist; later ones are added
 * by platform admins. Running it again for the same phone writes nothing. Both
 * writes are audited with this person as the actor, because no one else is.
 */
export const initPlatform = async (phoneText: string, name?: string): Promise<PlatformInitResult> => {
  const parsed = phoneSchema.safeParse(phoneText);
  if (!parsed.success) {
    throw new AppError('PHONE_INVALID', 'must be a phone number in E.164 format, e.g. +923001234567');
  }
  const phone = parsed.data;

  let user = await User.findOne({ phone });
  const createdUser = !user;
  if (!user) {
    user = await User.create({ phone, name: name ?? '' });
  } else if (name && !user.name) {
    user.name = name;
    await user.save();
  }

  const { platform, created: createdOrganisation } = await thePlatform(user);
  const scope: Scope = { practiceId: platform._id, actorId: user._id, role: 'platformAdmin', allowedLocationIds: [] };

  if (createdOrganisation) {
    await writeAudit(scope, {
      action: 'organisation.create',
      entity: 'practice',
      entityId: platform._id,
      after: { type: 'platform', name: platform.name, by: 'platform:init' },
    });
  }

  const existing = await Membership.findOne({ practiceId: platform._id, userId: user._id });
  const result = { organisationId: platform._id, userId: user._id, createdOrganisation, createdUser };
  if (existing?.status === 'active' && existing.role === 'platformAdmin') {
    return { ...result, grantedAdmin: false };
  }

  // One row per person per organisation, as in a clinic: a removed admin is reactivated.
  const membership =
    existing ??
    new Membership({ userId: user._id, practiceId: platform._id, locationIds: [], addedBy: user._id, createdBy: user._id });
  const before = existing ? { role: existing.role, status: existing.status } : null;

  membership.role = 'platformAdmin';
  membership.status = 'active';
  membership.removedAt = null;
  await membership.save();

  await writeAudit(scope, {
    action: 'member.add',
    entity: 'membership',
    entityId: membership._id,
    before,
    after: { role: 'platformAdmin', by: 'platform:init' },
  });

  return { ...result, grantedAdmin: true };
};

export default { backfillOrganisationTypes, initPlatform, PLATFORM_NAME };
