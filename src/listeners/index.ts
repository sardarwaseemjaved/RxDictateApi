import logger from '../config/logger';
import { on } from '../core/events';
import { sendMemberAdded } from '../core/sms';
import { Practice } from '../models';
import { notify, notifyPractice } from '../services/notification.service';

/**
 * Everything that happens after a write, rather than as part of one.
 *
 * Services emit facts; this file decides what they cause. Nothing in a service
 * calls notification or SMS code directly, so adding push later means adding a
 * handler here and editing no prescription code at all. A handler that throws
 * is logged by the bus and never reaches the request that emitted the event.
 */

on('patient.added', async ({ practiceId, patientId, actorId }) => {
  await notifyPractice({
    practiceId,
    type: 'patient.added',
    refId: patientId,
    title: 'New patient added',
    body: 'A patient was added to this clinic.',
    actorId,
    roles: ['doctor'],
  });
});

on('visit.statusChanged', async ({ practiceId, visitId, from, to, actorId }) => {
  await notifyPractice({
    practiceId,
    type: 'visit.statusChanged',
    refId: visitId,
    title: 'Visit updated',
    body: `A visit moved from ${from} to ${to}.`,
    actorId,
  });
});

on('prescription.approved', async ({ practiceId, prescriptionId, number, actorId }) => {
  await notifyPractice({
    practiceId,
    type: 'prescription.approved',
    refId: prescriptionId,
    title: 'Prescription approved',
    body: `${number} is ready to print.`,
    actorId,
    roles: ['pa'],
  });
});

on('prescription.revised', async ({ practiceId, prescriptionId, version, actorId }) => {
  await notifyPractice({
    practiceId,
    type: 'prescription.revised',
    refId: prescriptionId,
    title: 'Prescription revised',
    body: `A prescription was revised to version ${version}.`,
    actorId,
    roles: ['pa'],
  });
});

/**
 * The one piece of outbound messaging that matters today: a PA who has just
 * been added has no idea she can sign in until she is told.
 */
on('member.added', async ({ practiceId, userId, phone, role, membershipId, actorId }) => {
  const practice = await Practice.findById(practiceId);
  await sendMemberAdded(phone, practice?.name ?? 'the clinic', role);
  await notify({
    practiceId,
    userId,
    type: 'member.added',
    refId: membershipId,
    title: 'You were added to a clinic',
    body: `You can now sign in to ${practice?.name ?? 'the clinic'}.`,
    actorId,
  });
});

on('member.removed', async ({ practiceId, membershipId, userId, actorId }) => {
  await notify({
    practiceId,
    userId,
    type: 'member.removed',
    refId: membershipId,
    title: 'Your access was removed',
    body: 'You no longer have access to this clinic.',
    actorId,
  });
});

on('member.locationsChanged', async ({ practiceId, membershipId, userId, actorId }) => {
  await notify({
    practiceId,
    userId,
    type: 'member.locationsChanged',
    refId: membershipId,
    title: 'Your locations changed',
    body: 'The locations you work at were updated.',
    actorId,
  });
});

on('location.added', async ({ practiceId, locationId, actorId }) => {
  await notifyPractice({
    practiceId,
    type: 'location.added',
    refId: locationId,
    title: 'Location added',
    body: 'A new location was added to this clinic.',
    actorId,
  });
});

on('location.archived', async ({ practiceId, locationId, actorId }) => {
  await notifyPractice({
    practiceId,
    type: 'location.archived',
    refId: locationId,
    title: 'Location archived',
    body: 'A location was archived.',
    actorId,
  });
});

on('report.uploaded', async ({ practiceId, reportId, actorId }) => {
  await notifyPractice({
    practiceId,
    type: 'report.uploaded',
    refId: reportId,
    title: 'Report uploaded',
    body: 'A new report was attached to a patient.',
    actorId,
    roles: ['doctor'],
  });
});

/** Dictation that failed is the doctor's problem to see, not a silent gap. */
on('voice.segmentFailed', async ({ practiceId, prescriptionId, doctorId, seq, error }) => {
  logger.warn(`voice segment ${seq} failed on prescription ${String(prescriptionId)}: ${error}`);
  await notify({
    practiceId,
    userId: doctorId,
    type: 'voice.segmentFailed',
    refId: prescriptionId,
    title: 'Dictation could not be processed',
    body: `Part ${seq} of your dictation failed. You can retry it or type the lines in.`,
  });
});

on('voice.segmentApplied', ({ prescriptionId, seq, opCount }) => {
  logger.debug(`voice segment ${seq} applied ${opCount} ops to prescription ${String(prescriptionId)}`);
});

export default {};
