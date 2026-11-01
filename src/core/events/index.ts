import { EventEmitter } from 'events';
import type { Types } from 'mongoose';
import logger from '../../config/logger';
import type { Role } from '../../shared/roles';
import type { VisitStatus } from '../../shared/visit.schema';

/**
 * What happened, as past tense facts.
 *
 * Services emit; listeners act. Notification code, SMS, push and the realtime
 * socket are never called from a service, so adding push later means adding a
 * listener rather than editing prescription code. Some events exist only for
 * the realtime listener and cause no notification at all.
 */
export interface EventPayloads {
  'patient.added': { practiceId: Types.ObjectId; patientId: Types.ObjectId; actorId: Types.ObjectId };
  'patient.updated': { practiceId: Types.ObjectId; patientId: Types.ObjectId; actorId: Types.ObjectId };
  /** On a day's list, by hand or by starting a prescription. Not on a double tap that finds them already there. */
  'visit.added': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    visitId: Types.ObjectId;
    patientId: Types.ObjectId;
    actorId: Types.ObjectId;
  };
  /** Put somewhere else in the order. Others on the list may have been renumbered with it. */
  'visit.moved': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    visitId: Types.ObjectId;
    actorId: Types.ObjectId;
  };
  'visit.statusChanged': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    visitId: Types.ObjectId;
    from: VisitStatus;
    to: VisitStatus;
    actorId: Types.ObjectId;
  };
  'voice.segmentApplied': {
    practiceId: Types.ObjectId;
    prescriptionId: Types.ObjectId;
    segmentId: Types.ObjectId;
    seq: number;
    opCount: number;
  };
  'voice.segmentFailed': {
    practiceId: Types.ObjectId;
    prescriptionId: Types.ObjectId;
    segmentId: Types.ObjectId;
    seq: number;
    doctorId: Types.ObjectId;
    error: string;
  };
  'prescription.approved': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    prescriptionId: Types.ObjectId;
    patientId: Types.ObjectId;
    number: string;
    actorId: Types.ObjectId;
  };
  'prescription.revised': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    prescriptionId: Types.ObjectId;
    previousVersionId: Types.ObjectId;
    version: number;
    actorId: Types.ObjectId;
  };
  'member.added': {
    practiceId: Types.ObjectId;
    membershipId: Types.ObjectId;
    userId: Types.ObjectId;
    phone: string;
    role: Role;
    actorId: Types.ObjectId;
  };
  'member.removed': {
    practiceId: Types.ObjectId;
    membershipId: Types.ObjectId;
    userId: Types.ObjectId;
    actorId: Types.ObjectId;
  };
  'member.locationsChanged': {
    practiceId: Types.ObjectId;
    membershipId: Types.ObjectId;
    userId: Types.ObjectId;
    locationIds: Types.ObjectId[];
    actorId: Types.ObjectId;
  };
  /** A doctor made a PA or the other way round, which changes which locations and patients they reach. */
  'member.roleChanged': {
    practiceId: Types.ObjectId;
    membershipId: Types.ObjectId;
    userId: Types.ObjectId;
    role: Role;
    locationIds: Types.ObjectId[];
    actorId: Types.ObjectId;
  };
  'location.added': { practiceId: Types.ObjectId; locationId: Types.ObjectId; actorId: Types.ObjectId };
  'location.updated': { practiceId: Types.ObjectId; locationId: Types.ObjectId; actorId: Types.ObjectId };
  'location.archived': { practiceId: Types.ObjectId; locationId: Types.ObjectId; actorId: Types.ObjectId };
  'vitals.recorded': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    visitId: Types.ObjectId;
    patientId: Types.ObjectId;
    /** Which readings were out of range, so a listener need not re-derive them. */
    flaggedFields: string[];
    actorId: Types.ObjectId;
  };
  'appointment.booked': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    appointmentId: Types.ObjectId;
    patientId: Types.ObjectId;
    at: Date;
    actorId: Types.ObjectId;
  };
  'appointment.cancelled': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    appointmentId: Types.ObjectId;
    actorId: Types.ObjectId;
  };
  /** The patient came: putting them on that day's list marks their booking kept. */
  'appointment.arrived': {
    practiceId: Types.ObjectId;
    locationId: Types.ObjectId;
    appointmentId: Types.ObjectId;
    visitId: Types.ObjectId;
    actorId: Types.ObjectId;
  };
  'session.revoked': {
    userId: Types.ObjectId;
    sessionId: Types.ObjectId;
    reason: 'logout' | 'logout_all' | 'reuse_detected' | 'expired' | 'admin';
  };
  'report.uploaded': {
    practiceId: Types.ObjectId;
    patientId: Types.ObjectId;
    reportId: Types.ObjectId;
    actorId: Types.ObjectId;
  };
  /** Marked seen. Only the first look: reviewing again changes nothing and says nothing. */
  'report.reviewed': {
    practiceId: Types.ObjectId;
    patientId: Types.ObjectId;
    reportId: Types.ObjectId;
    actorId: Types.ObjectId;
  };
  /** Written to these people's inboxes. One event for a fan-out, not one per person. */
  'notification.created': { practiceId: Types.ObjectId; userIds: Types.ObjectId[] };
  /** Some of this person's notifications were marked read, which moves their badge on every device. */
  'notification.read': { practiceId: Types.ObjectId; userId: Types.ObjectId };
}

export type EventName = keyof EventPayloads;

const emitter = new EventEmitter();
// A fan-out of listeners per event is expected; the default of 10 is not a
// ceiling worth hitting in production.
emitter.setMaxListeners(50);

/**
 * Fire and forget. A listener that throws must never take down the write that
 * caused it, which is why every handler is wrapped rather than trusted.
 */
export const emit = <K extends EventName>(name: K, payload: EventPayloads[K]): void => {
  emitter.emit(name, payload);
};

export const on = <K extends EventName>(name: K, handler: (payload: EventPayloads[K]) => void | Promise<void>): void => {
  emitter.on(name, (payload: EventPayloads[K]) => {
    Promise.resolve()
      .then(() => handler(payload))
      .catch((error: Error) => {
        logger.error(`listener for ${name} failed: ${error.message}`);
      });
  });
};

/** Only for tests, which must not inherit listeners from another file's import. */
export const removeAllListeners = (): void => {
  emitter.removeAllListeners();
};

export const bus = { emit, on, removeAllListeners };

export default bus;
