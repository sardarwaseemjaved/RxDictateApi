import { createHash, randomBytes } from 'crypto';
import type { Types } from 'mongoose';
import config from '../config/config';
import { LIVE_LINK_STATUSES, Patient, PatientInvite, PatientLink, Prescription, type PatientDoc } from '../models';
import type { Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import {
  PORTAL_INVITE_COOLDOWN_HOURS,
  PORTAL_INVITE_EXPIRY_DAYS,
  type PatientPortalState,
  type PatientPortalView,
  type UpdatePatientPortalBody,
} from '../shared/portal.schema';
import { addDays } from '../utils/time';
import { findPatientOrFail } from './patient.service';
import { endPortalAccess, hasLapsed, portalIsOn } from './patientLink.service';
import { organisationSetting } from './settings.service';

/**
 * A patient's online access as the clinic sees and controls it, under
 * /patients/:id/portal. Every route starts at findPatientOrFail, so an assistant
 * reaches only the patients of their own locations.
 */

const COOLDOWN_MS = PORTAL_INVITE_COOLDOWN_HOURS * 60 * 60 * 1000;

/** 16 random bytes, base64url: 22 characters, and far too many to guess, so a plain hash is enough to store. */
export const newInviteCode = (): string => randomBytes(16).toString('base64url');

export const inviteCodeHash = (code: string): string => createHash('sha256').update(code).digest('hex');

/** The link an invite's SMS holds. */
export const inviteUrl = (code: string): string => `${config.invite.baseUrl}/${code}`;

const viewOf = async (scope: Scope, patient: PatientDoc): Promise<PatientPortalView> => {
  const where = { practiceId: scope.practiceId, patientId: patient._id };
  const [link, invite, enabled] = await Promise.all([
    PatientLink.findOne({ ...where, status: { $in: LIVE_LINK_STATUSES } }).sort({ linkedAt: -1 }),
    PatientInvite.findOne(where),
    portalIsOn(scope.practiceId),
  ]);

  const now = new Date();
  const invited = invite?.codeHash && !invite.usedAt && invite.expiresAt && invite.expiresAt > now;
  let status: PatientPortalState = invited ? 'invited' : 'none';
  if (link) {
    // Worked out here too, because it may be months before the patient comes back to flip it.
    status = link.status === 'dormant' || hasLapsed(link, now) ? 'dormant' : 'linked';
  }

  return {
    status,
    invitedAt: invite?.lastSentAt ?? null,
    linkedAt: link?.linkedAt ?? null,
    blocked: patient.portalBlocked,
    available: enabled && patient.phone !== '',
  };
};

export const getPortal = async (scope: Scope, patientId: string): Promise<PatientPortalView> =>
  viewOf(scope, await findPatientOrFail(scope, patientId));

/**
 * A new code in the record's one invite row, replacing any before it, or false
 * when the limits say no. The filter is what decides, so two taps at once send
 * one SMS: a row that doesn't match makes the upsert collide on the unique
 * patientId rather than insert.
 */
const issueInvite = async (scope: Scope, patient: PatientDoc, how: 'manual' | 'auto'): Promise<boolean> => {
  const now = new Date();
  const code = newInviteCode();
  const auto = how === 'auto';

  try {
    await PatientInvite.findOneAndUpdate(
      {
        practiceId: scope.practiceId,
        patientId: patient._id,
        $or: [{ lastSentAt: null }, { lastSentAt: { $lte: new Date(now.getTime() - COOLDOWN_MS) } }],
        ...(auto ? { autoSentAt: null } : {}),
      },
      {
        $set: {
          codeHash: inviteCodeHash(code),
          expiresAt: addDays(now, PORTAL_INVITE_EXPIRY_DAYS),
          usedAt: null,
          lastSentAt: now,
          sentBy: scope.actorId,
          ...(auto ? { autoSentAt: now } : {}),
        },
      },
      { upsert: true },
    );
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return false;
    }
    throw error;
  }

  await writeAudit(scope, { action: 'patient.portal.invite', entity: 'patient', entityId: patient._id, after: { how } });
  emit('patient.portalInvited', {
    practiceId: scope.practiceId,
    patientId: patient._id,
    phone: patient.phone,
    code,
    actorId: scope.actorId,
  });
  emit('patient.updated', { practiceId: scope.practiceId, patientId: patient._id, actorId: scope.actorId });
  return true;
};

/** Staff, from the patient. */
export const sendInvite = async (scope: Scope, patientId: string): Promise<PatientPortalView> => {
  const patient = await findPatientOrFail(scope, patientId);

  if (!(await portalIsOn(scope.practiceId))) {
    throw new AppError('FEATURE_DISABLED', 'Online access is off for this clinic.');
  }
  if (!patient.phone) {
    throw new AppError('VALIDATION_ERROR', 'This patient has no phone number to send an invite to.');
  }
  if (patient.portalBlocked) {
    throw new AppError('CONFLICT', 'This patient\'s record is set to "Don\'t share online".');
  }
  const active = await PatientLink.findOne({ practiceId: scope.practiceId, patientId: patient._id, status: 'active' });
  if (active && !hasLapsed(active)) {
    throw new AppError('CONFLICT', 'This record is already linked.');
  }

  if (!(await issueInvite(scope, patient, 'manual'))) {
    const invite = await PatientInvite.findOne({ practiceId: scope.practiceId, patientId: patient._id });
    throw new AppError('PORTAL_INVITE_TOO_SOON', 'An invite was sent recently. It can be sent again tomorrow.', {
      retryAt: invite?.lastSentAt ? new Date(invite.lastSentAt.getTime() + COOLDOWN_MS) : null,
    });
  }
  return viewOf(scope, patient);
};

/**
 * With `portal.invites` on `auto`, after a patient's first approved prescription.
 *
 * Called by a listener once the approval has already answered, so it can't delay
 * or fail one. A revision is not a first: by then the version it replaced counts
 * too. Staged behind the same limits as a manual invite, so it stays quiet if
 * somebody sent one at the desk a moment ago.
 */
export const inviteAfterApproval = async (approved: {
  practiceId: Types.ObjectId;
  patientId: Types.ObjectId;
  actorId: Types.ObjectId;
}): Promise<void> => {
  const { practiceId, patientId, actorId } = approved;

  const [enabled, mode] = await Promise.all([portalIsOn(practiceId), organisationSetting(practiceId, 'portal.invites')]);
  if (!enabled || mode !== 'auto') {
    return;
  }

  const patient = await Patient.findOne({ _id: patientId, practiceId, deletedAt: null });
  if (!patient?.phone || patient.portalBlocked) {
    return;
  }

  const active = await PatientLink.findOne({ practiceId, patientId, status: 'active' });
  if (active && !hasLapsed(active)) {
    return;
  }

  const signed = await Prescription.countDocuments({
    practiceId,
    patientId,
    status: { $in: ['approved', 'superseded'] },
    deletedAt: null,
  });
  if (signed !== 1) {
    return;
  }

  await issueInvite({ practiceId, actorId, role: 'doctor', allowedLocationIds: 'all' }, patient, 'auto');
};

/** "Don't share online". Turning it on ends any link and any invite; turning it off brings neither back. */
export const updatePortal = async (
  scope: Scope,
  patientId: string,
  body: UpdatePatientPortalBody,
): Promise<PatientPortalView> => {
  const patient = await findPatientOrFail(scope, patientId);

  if (patient.portalBlocked !== body.blocked) {
    patient.portalBlocked = body.blocked;
    await patient.save();
    await writeAudit(scope, {
      action: body.blocked ? 'patient.portal.block' : 'patient.portal.unblock',
      entity: 'patient',
      entityId: patient._id,
      before: { blocked: !body.blocked },
      after: { blocked: body.blocked },
    });
    if (body.blocked) {
      await endPortalAccess(scope, patient._id, 'blocked');
    }
    emit('patient.updated', { practiceId: scope.practiceId, patientId: patient._id, actorId: scope.actorId });
  }

  return viewOf(scope, patient);
};

/** The clinic removes the link. Nothing to remove answers the same, so a double tap isn't an error. */
export const removeLink = async (scope: Scope, patientId: string): Promise<PatientPortalView> => {
  const patient = await findPatientOrFail(scope, patientId);

  const linked = await PatientLink.exists({
    practiceId: scope.practiceId,
    patientId: patient._id,
    status: { $in: LIVE_LINK_STATUSES },
  });
  if (linked) {
    await endPortalAccess(scope, patient._id, 'clinic');
    emit('patient.updated', { practiceId: scope.practiceId, patientId: patient._id, actorId: scope.actorId });
  }

  return viewOf(scope, patient);
};

export default { getPortal, sendInvite, inviteAfterApproval, updatePortal, removeLink, inviteCodeHash, inviteUrl };
