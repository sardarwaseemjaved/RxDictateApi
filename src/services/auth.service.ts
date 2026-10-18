import { randomInt } from 'crypto';
import type { Types } from 'mongoose';
import config from '../config/config';
import logger from '../config/logger';
import { Location, Membership, OtpCode, Practice, User, type LocationDoc, type UserDoc } from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { sendOtp as sendOtpSms } from '../core/sms';
import type { AuthIntent, DeviceInfo, MembershipView, Session, TokenPair } from '../shared/auth.schema';
import { addMinutes } from '../utils/time';
import { forgetDevice, identifySession, revokeSession, rotateSession, startSession } from './session.service';

/**
 * Six digits from a CSPRNG. crypto.randomInt is uniform, unlike
 * Math.random() * 900000, which is both biased and predictable.
 */
const generateCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

const maskPhone = (phone: string): string => `***${phone.slice(-3)}`;

/**
 * Issue a code and text it.
 *
 * Any code still outstanding for the number is deleted first, so only the most
 * recent one ever verifies - that is what makes "resend" safe rather than a way
 * to have five live codes at once.
 *
 * The per-phone cooldown is enforced here as well as by the rate limiter,
 * because this one is the one that survives a restart and counts the number
 * being texted rather than the connection asking.
 */
export const sendOtp = async (phone: string): Promise<{ devCode?: string }> => {
  const now = new Date();

  const outstanding = await OtpCode.findOne({ phone, expiresAt: { $gt: now } }).sort({ createdAt: -1 });
  if (outstanding) {
    const waitedSeconds = Math.floor((now.getTime() - outstanding.createdAt.getTime()) / 1000);
    const remaining = config.otp.cooldownSeconds - waitedSeconds;
    if (remaining > 0) {
      throw new AppError('OTP_COOLDOWN', `Please wait ${remaining} seconds before asking for another code.`, {
        retryAfterSeconds: remaining,
      });
    }
  }

  await OtpCode.deleteMany({ phone });

  /**
   * Only the value is predictable when a fixed code is configured. It is still
   * hashed, still expires, still counts wrong attempts and is still single use,
   * so what a client exercises in testing is the real flow rather than a
   * shortcut around it.
   */
  const code = config.otp.fixedCode ?? generateCode();
  await OtpCode.create({
    phone,
    // Hashed by the model's pre-save hook.
    codeHash: code,
    expiresAt: addMinutes(now, config.otp.expirationMinutes),
  });

  await sendOtpSms(phone, code);

  if (config.otp.exposeInResponse) {
    logger.info(`[dev] sign-in code for ${maskPhone(phone)} is ${code}`);
    return { devCode: code };
  }
  return {};
};

/**
 * Consume a code: a correct one is deleted, a wrong guess is counted, and a
 * code that runs out of attempts is burned so it cannot be ground down.
 */
const consumeOtp = async (phone: string, candidate: string): Promise<void> => {
  const otp = await OtpCode.findOne({ phone }).sort({ createdAt: -1 });

  if (!otp) {
    throw new AppError('OTP_EXPIRED', 'That code has expired. Please ask for a new one.');
  }
  if (otp.expiresAt.getTime() < Date.now()) {
    await OtpCode.deleteOne({ _id: otp._id });
    throw new AppError('OTP_EXPIRED', 'That code has expired. Please ask for a new one.');
  }

  if (!(await otp.isCodeMatch(candidate))) {
    otp.attempts += 1;
    const exhausted = otp.attempts >= config.otp.maxAttempts;
    if (exhausted) {
      await OtpCode.deleteOne({ _id: otp._id });
    } else {
      await otp.save();
    }
    logger.warn(`wrong sign-in code for ${maskPhone(phone)}, attempt ${otp.attempts}`);
    throw exhausted
      ? new AppError('OTP_LOCKED', 'Too many wrong attempts. Please ask for a new code.')
      : new AppError('OTP_INVALID', 'That code is not right.');
  }

  await OtpCode.deleteOne({ _id: otp._id });
};

/**
 * Everything a doctor needs to start working: a practice, one location called
 * "My clinic", and his own membership as doctor.
 *
 * Only ever called for someone who asked for a clinic and has none. Running it
 * for any phone with no memberships was wrong: an assistant who signs in
 * before the doctor adds her would get a clinic of her own, be walked through
 * doctor setup, and end up belonging to two.
 *
 * The UI never says "practice". To the doctor this is just his clinic.
 */
export const bootstrapPractice = async (user: UserDoc): Promise<void> => {
  const practice = await Practice.create({
    name: user.name ? `${user.name}'s clinic` : 'My clinic',
    ownerId: user._id,
    features: { voice: true, templates: false },
    settings: { audioRetentionDays: config.practiceDefaults.audioRetentionDays },
    rxCounter: 0,
    createdBy: user._id,
  });

  const location = await Location.create({
    practiceId: practice._id,
    name: 'My clinic',
    isDefault: true,
    status: 'active',
    createdBy: user._id,
  });

  const membership = await Membership.create({
    userId: user._id,
    practiceId: practice._id,
    role: 'doctor',
    locationIds: [location._id],
    status: 'active',
    addedBy: user._id,
    createdBy: user._id,
  });

  const scope = {
    practiceId: practice._id,
    actorId: user._id,
    role: 'doctor' as const,
    allowedLocationIds: 'all' as const,
  };

  await writeAudit(scope, {
    action: 'practice.create',
    entity: 'practice',
    entityId: practice._id,
    after: { name: practice.name },
  });
  await writeAudit(scope, {
    action: 'location.create',
    entity: 'location',
    entityId: location._id,
    locationId: location._id,
    after: { name: location.name, isDefault: true },
  });
  await writeAudit(scope, {
    action: 'member.add',
    entity: 'membership',
    entityId: membership._id,
    after: { role: 'doctor', bootstrap: true },
  });

  logger.info(`bootstrapped a clinic for user ${String(user._id)}`);
};

/** A membership as the app sees it, with the locations it covers resolved. */
export const membershipViews = async (userId: Types.ObjectId): Promise<MembershipView[]> => {
  const memberships = await Membership.find({ userId, status: 'active' });

  return Promise.all(
    memberships.map(async (membership) => {
      const practice = await Practice.findById(membership.practiceId);
      // A doctor may use any location of his practice, so his list is every
      // active one rather than whatever happens to be on the membership.
      const locations: LocationDoc[] =
        membership.role === 'doctor'
          ? await Location.find({ practiceId: membership.practiceId, deletedAt: null })
          : await Location.find({ _id: { $in: membership.locationIds }, deletedAt: null });

      return {
        id: String(membership._id),
        practiceId: String(membership.practiceId),
        practiceName: practice?.name ?? '',
        role: membership.role,
        locationIds: locations.map((location) => String(location._id)),
        locations: locations.map((location) => ({
          id: String(location._id),
          name: location.name,
          isDefault: location.isDefault,
          status: location.status,
        })),
      };
    }),
  );
};

const sessionFor = async (user: UserDoc, tokens: TokenPair, devCode?: string): Promise<Session> => ({
  user: {
    id: String(user._id),
    phone: user.phone,
    name: user.name,
    lastLoginAt: user.lastLoginAt,
  },
  memberships: await membershipViews(user._id),
  tokens,
  ...(devCode ? { devCode } : {}),
});

/**
 * Exchange a code for a session.
 *
 * The user is created here if the number is new: there is no separate register
 * endpoint, because a phone number that verifies is a person. Whether that
 * person also gets a clinic is what `intent` decides.
 */
export const verifyOtp = async (
  phone: string,
  code: string,
  device: DeviceInfo,
  name?: string,
  intent: AuthIntent = 'signIn',
): Promise<Session> => {
  await consumeOtp(phone, code);

  let user = await User.findOne({ phone });
  if (!user) {
    user = await User.create({ phone, name: name ?? '' });
  } else if (name && !user.name) {
    user.name = name;
  }

  user.lastLoginAt = new Date();
  await user.save();

  /**
   * A clinic is created only when somebody asked for one. A signIn from a
   * number nobody has added succeeds with no memberships, and the app shows
   * its "this number isn't linked to a clinic yet" screen.
   */
  const existing = await Membership.countDocuments({ userId: user._id, status: 'active' });
  if (intent === 'signUp' && existing === 0) {
    await bootstrapPractice(user);
  }

  // A sign-in is recorded against every clinic the person can act in, so an
  // audit trail of who was in the system when has no gaps.
  const memberships = await Membership.find({ userId: user._id, status: 'active' });
  await Promise.all(
    memberships.map((membership) =>
      writeAudit(
        {
          practiceId: membership.practiceId,
          actorId: user!._id,
          role: membership.role,
          allowedLocationIds: membership.role === 'doctor' ? 'all' : membership.locationIds,
        },
        { action: 'auth.signIn', entity: 'user', entityId: user!._id },
      ),
    ),
  );

  // Any session this phone already had is retired, so one device holds one.
  const { tokens } = await startSession(user, device);
  logger.info(`sign-in for user ${String(user._id)} on device ${device.platform}`);
  return sessionFor(user, tokens);
};

/**
 * Single-use refresh: the token presented is replaced, and a token that comes
 * back twice ends the session rather than being guessed about.
 */
export const refresh = async (refreshToken: string): Promise<Session> => {
  const { session, tokens } = await rotateSession(refreshToken);

  const user = await User.findById(session.userId);
  if (!user) {
    // The account went away under a live session.
    await revokeSession(session, 'admin');
    throw new AppError('SESSION_REVOKED', 'Please sign in again');
  }

  return sessionFor(user, tokens);
};

/**
 * Sign out of this device.
 *
 * Identified from either credential, so a phone whose access token lapsed
 * while the app was backgrounded can still end its session rather than
 * leaving a live one behind. Never fails: a sign-out the app has to handle an
 * error from is a sign-out that leaves a session open.
 *
 * The audit row is written per clinic the person can act in, the same way a
 * sign-in is, because auditLogs is practice-scoped and a sign-out is a fact
 * each of those clinics may need to account for.
 */
export const logout = async (
  accessToken: string | undefined,
  refreshToken: string | undefined,
  context: { requestId?: string | null; ip?: string | null } = {},
): Promise<void> => {
  const session = await identifySession(accessToken, refreshToken);
  if (!session) {
    // Nothing to end. Still a success: the caller is signed out either way.
    return;
  }

  const { revoked } = await revokeSession(session, 'logout');
  if (!revoked) {
    // Already signed out, so the first answer stands.
    return;
  }

  await forgetDevice(session.userId, session.deviceId);

  const memberships = await Membership.find({ userId: session.userId, status: 'active' });
  await Promise.all(
    memberships.map((membership) =>
      writeAudit(
        {
          practiceId: membership.practiceId,
          actorId: session.userId,
          role: membership.role,
          allowedLocationIds: membership.role === 'doctor' ? 'all' : membership.locationIds,
        },
        {
          action: 'auth.logout',
          entity: 'session',
          entityId: session._id,
          // Device and platform only. No token, hashed or otherwise.
          after: { deviceId: session.deviceId, platform: session.platform },
          requestId: context.requestId ?? null,
          ip: context.ip ?? null,
        },
      ),
    ),
  );

  logger.info(`sign-out for user ${String(session.userId)}`);
};

export default { sendOtp, verifyOtp, refresh, logout, membershipViews, bootstrapPractice };
