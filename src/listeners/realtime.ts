import type { Types } from 'mongoose';
import { on } from '../core/events';
import { deliver, type Audience } from '../core/realtime';
import { Patient, Prescription } from '../models';
import type { ErrorCode } from '../shared/errorCodes';
import type { RealtimeTopic } from '../shared/realtime.schema';

/**
 * What each write means to the apps that are open, over the realtime socket.
 *
 * A message says which topic changed and at most an id, never the data: the
 * app refetches through the ordinary routes, so permissions and who sees which
 * patient are decided there and only there. The person who made the change
 * hears it too, because they may have the app open on another device.
 *
 * Everything goes through deliver(), never to a socket directly.
 */

const tell = (audience: Audience, topic: RealtimeTopic, id?: Types.ObjectId): void => {
  deliver({ kind: 'send', audience, message: { type: 'changed', topic, ...(id ? { id: String(id) } : {}) } });
};

/** Access has ended: say why, then close. */
const shut = (audience: Audience, code: ErrorCode, message: string): void => {
  deliver({ kind: 'close', audience, code, message });
};

const atLocation = (locationId: Types.ObjectId): Audience => ({ to: 'location', locationId: String(locationId) });

const member = (practiceId: Types.ObjectId, userId: Types.ObjectId): Audience => ({
  to: 'member',
  practiceId: String(practiceId),
  userId: String(userId),
});

const everyone = (practiceId: Types.ObjectId): Audience => ({ to: 'practice', practiceId: String(practiceId) });

/** Everyone who may see this patient: the doctors, and the assistants at a location they are linked to. */
const whoSees = async (practiceId: Types.ObjectId, patientId: Types.ObjectId): Promise<Audience | null> => {
  const patient = await Patient.findOne({ _id: patientId, practiceId }).select('locationIds');
  return patient ? { to: 'patient', practiceId: String(practiceId), linkedTo: patient.locationIds.map(String) } : null;
};

const tellWhoSees = async (
  practiceId: Types.ObjectId,
  patientId: Types.ObjectId,
  topic: RealtimeTopic,
  id: Types.ObjectId,
): Promise<void> => {
  const audience = await whoSees(practiceId, patientId);
  if (audience) {
    tell(audience, topic, id);
  }
};

/* Today's list, at the visit's location. */
on('visit.added', ({ locationId, visitId }) => tell(atLocation(locationId), 'visits', visitId));
on('visit.statusChanged', ({ locationId, visitId }) => tell(atLocation(locationId), 'visits', visitId));
on('visit.moved', ({ locationId, visitId }) => tell(atLocation(locationId), 'visits', visitId));
on('vitals.recorded', ({ locationId, visitId }) => tell(atLocation(locationId), 'vitals', visitId));

/* Ready to print, at the prescription's location. */
on('prescription.approved', ({ locationId, prescriptionId }) =>
  tell(atLocation(locationId), 'prescriptions', prescriptionId),
);
on('prescription.revised', ({ locationId, prescriptionId }) =>
  tell(atLocation(locationId), 'prescriptions', prescriptionId),
);

/* The Schedule, at the appointment's location. */
on('appointment.booked', ({ locationId, appointmentId }) => tell(atLocation(locationId), 'appointments', appointmentId));
on('appointment.cancelled', ({ locationId, appointmentId }) => tell(atLocation(locationId), 'appointments', appointmentId));
on('appointment.arrived', ({ locationId, appointmentId }) => tell(atLocation(locationId), 'appointments', appointmentId));

/* Patients and their reports, to whoever may see the patient. */
on('patient.added', ({ practiceId, patientId }) => tellWhoSees(practiceId, patientId, 'patients', patientId));
on('patient.updated', ({ practiceId, patientId }) => tellWhoSees(practiceId, patientId, 'patients', patientId));
on('report.uploaded', ({ practiceId, patientId, reportId }) => tellWhoSees(practiceId, patientId, 'reports', reportId));
on('report.reviewed', ({ practiceId, patientId, reportId }) => tellWhoSees(practiceId, patientId, 'reports', reportId));

/* A person's own inbox, on every device they have it open on. */
on('notification.created', ({ practiceId, userIds }) => {
  userIds.forEach((userId) => tell(member(practiceId, userId), 'notifications'));
});
on('notification.read', ({ practiceId, userId }) => tell(member(practiceId, userId), 'notifications'));

/* The team and the locations, to the whole clinic - after closing whatever just lost access. */
on('member.added', ({ practiceId, membershipId }) => tell(everyone(practiceId), 'team', membershipId));

on('member.removed', ({ practiceId, membershipId, userId }) => {
  shut(member(practiceId, userId), 'MEMBERSHIP_REMOVED', 'You have been removed from this clinic.');
  tell(everyone(practiceId), 'team', membershipId);
});

on('member.locationsChanged', ({ practiceId, membershipId, userId, locationIds }) => {
  deliver({ kind: 'access', practiceId: String(practiceId), userId: String(userId), locationIds: locationIds.map(String) });
  tell(everyone(practiceId), 'team', membershipId);
});

on('member.roleChanged', ({ practiceId, membershipId, userId, role, locationIds }) => {
  deliver({
    kind: 'access',
    practiceId: String(practiceId),
    userId: String(userId),
    role,
    locationIds: locationIds.map(String),
  });
  tell(everyone(practiceId), 'team', membershipId);
});

on('location.added', ({ practiceId, locationId }) => tell(everyone(practiceId), 'locations', locationId));
on('location.updated', ({ practiceId, locationId }) => tell(everyone(practiceId), 'locations', locationId));

on('location.archived', ({ practiceId, locationId }) => {
  shut(atLocation(locationId), 'LOCATION_ARCHIVED', 'That location has been archived');
  tell(everyone(practiceId), 'locations', locationId);
});

/* Dictation, to the doctor whose prescription it is. */
on('voice.segmentApplied', async ({ practiceId, prescriptionId }) => {
  const prescription = await Prescription.findOne({ _id: prescriptionId, practiceId }).select('doctorId');
  if (prescription) {
    tell(member(practiceId, prescription.doctorId), 'voice', prescriptionId);
  }
});
on('voice.segmentFailed', ({ practiceId, prescriptionId, doctorId }) =>
  tell(member(practiceId, doctorId), 'voice', prescriptionId),
);

/* A session that ended takes its sockets with it. */
on('session.revoked', ({ sessionId }) => {
  shut(
    { to: 'session', sessionId: String(sessionId) },
    'SESSION_REVOKED',
    'You have been signed out. Please sign in again.',
  );
});

export default {};
