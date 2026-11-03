import type { Types } from 'mongoose';
import { LIVE_LINK_STATUSES, PatientInvite, PatientLink, type PatientLinkDoc, type PatientLinkEndReason } from '../models';
import type { Scope } from '../core/db';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import { PORTAL_LINK_DORMANT_DAYS } from '../shared/portal.schema';
import { addDays } from '../utils/time';
import { organisationSetting } from './settings.service';

/**
 * What both sides of a patient's link need: the patient's area, and the clinic
 * changing a record. Kept apart from both so patient.service can end links
 * without depending on anything that depends on it.
 */

/** Whether this clinic's patients can link and see records at all. */
export const portalIsOn = async (practiceId: Types.ObjectId): Promise<boolean> =>
  organisationSetting(practiceId, 'portal.enabled');

/** Unused for long enough that it needs a new code, whether or not anybody has noticed yet. */
export const hasLapsed = (link: PatientLinkDoc, now: Date = new Date()): boolean =>
  link.lastUsedAt <= addDays(now, -PORTAL_LINK_DORMANT_DAYS);

/** The scope a patient's own writes are audited with. A label for the audit log: it grants nothing. */
export const patientScope = (practiceId: Types.ObjectId, userId: Types.ObjectId): Scope => ({
  practiceId,
  actorId: userId,
  role: 'patient',
  allowedLocationIds: [],
});

/**
 * An active link past its time becomes dormant, on the first access after that.
 * Nothing runs on a timer, so this is called wherever a person reaches a link.
 */
export const settleLapsedLink = async (link: PatientLinkDoc): Promise<void> => {
  if (link.status !== 'active' || !hasLapsed(link)) {
    return;
  }
  const changed = await PatientLink.updateOne({ _id: link._id, status: 'active' }, { $set: { status: 'dormant' } });
  // eslint-disable-next-line no-param-reassign
  link.status = 'dormant';
  if (changed.modifiedCount > 0) {
    await writeAudit(patientScope(link.practiceId, link.userId), {
      action: 'patient.portal.dormant',
      entity: 'patientLink',
      entityId: link._id,
      before: { status: 'active' },
      after: { status: 'dormant' },
    });
    emit('patient.updated', { practiceId: link.practiceId, patientId: link.patientId, actorId: link.userId });
  }
};

/**
 * Whatever gives this record online access stops now: every link it has, and
 * any invite that hasn't been used. A dormant link ends with the active ones,
 * or a new code could bring back a link whose proof has gone.
 */
export const endPortalAccess = async (
  scope: Scope,
  patientId: Types.ObjectId,
  reason: Exclude<PatientLinkEndReason, 'patient'>,
): Promise<void> => {
  const where = { practiceId: scope.practiceId, patientId };

  await PatientInvite.updateOne(
    { ...where, usedAt: null, codeHash: { $type: 'string' } },
    { $set: { codeHash: null, expiresAt: null } },
  );

  const live = await PatientLink.find({ ...where, status: { $in: LIVE_LINK_STATUSES } });
  if (live.length === 0) {
    return;
  }

  const removedAt = new Date();
  await PatientLink.updateMany(
    { _id: { $in: live.map((link) => link._id) } },
    { $set: { status: 'removed', removedBy: scope.actorId, removedAt, removedReason: reason } },
  );
  await Promise.all(
    live.map((link) =>
      writeAudit(scope, {
        action: 'patient.portal.unlink',
        entity: 'patientLink',
        entityId: link._id,
        before: { status: link.status },
        after: { status: 'removed', reason },
      }),
    ),
  );
};

export default { portalIsOn, hasLapsed, patientScope, settleLapsedLink, endPortalAccess };
