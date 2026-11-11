import { Types } from 'mongoose';
import { WebSocket } from 'ws';
import type { ErrorCode } from '../../shared/errorCodes';
import type { RealtimeServerMessage, RealtimeTopic } from '../../shared/realtime.schema';
import type { Action, Role } from '../../shared/roles';
import { canSeePatient } from '../../services/patient.service';
import { can } from '../permissions';
import { allowedLocationsFor } from '../tenancy';
import { everyConnection, inPractice, ofMember, onLocation, onSession, unregister, type Connection } from './registry';

/** The WebSocket close code for every close that comes with an error message: 1008, policy violation. */
export const CLOSE_POLICY = 1008;

/**
 * Who a delivery is for. Plain strings, so a delivery can be serialised and
 * handed to another process unchanged.
 *
 * `patient` is whoever may see a patient linked to these locations, by the
 * same rule the patient routes use (canSeePatient): every doctor, and the
 * assistants at one of those locations.
 *
 * `all` is every open socket, for what applies to everyone, like a
 * platform-wide setting.
 */
export type Audience =
  | { to: 'location'; locationId: string }
  | { to: 'member'; practiceId: string; userId: string }
  | { to: 'session'; sessionId: string }
  | { to: 'practice'; practiceId: string }
  | { to: 'patient'; practiceId: string; linkedTo: string[] }
  | { to: 'all' };

/**
 * Everything a write can do to open connections.
 *
 * - `send`: a message to an audience.
 * - `close`: tell an audience why, then close their sockets.
 * - `access`: a member's role or locations changed. Their sockets on a
 *   location they lost are closed with LOCATION_NOT_ALLOWED, and the rest
 *   start hearing about patients by the new rule. `role` is left out when only
 *   the locations changed.
 */
export type Delivery =
  | { kind: 'send'; audience: Audience; message: RealtimeServerMessage }
  | { kind: 'close'; audience: Audience; code: ErrorCode; message: string }
  | { kind: 'access'; practiceId: string; userId: string; role?: Role; locationIds: string[] };

/** One message to one socket, if it is still open to hear it. */
export const sendTo = (socket: WebSocket, message: RealtimeServerMessage): void => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

/**
 * Say why, then close. The error code is also the close reason, for a client
 * that only looks at the close event.
 */
export const refuse = (socket: WebSocket, code: ErrorCode, message: string): void => {
  sendTo(socket, { type: 'error', code, message });
  if (socket.readyState === WebSocket.OPEN) {
    socket.close(CLOSE_POLICY, code);
  }
};

/** Out of the registry first, so nothing else is sent to a socket on its way out. */
export const closeConnection = (connection: Connection, code: ErrorCode, message: string): void => {
  unregister(connection);
  refuse(connection.socket, code, message);
};

/**
 * What a member must hold to hear a topic. Reaching every location is not the
 * same as seeing what happens there: a medicine manager reaches them all and
 * must not hear about patients, visits or prescriptions, even as a bare id.
 * Null is for what everyone in an organisation hears; a list is any one of them.
 */
const TOPIC_READ: Record<RealtimeTopic, Action | readonly Action[] | null> = {
  visits: 'visit.read',
  vitals: 'visit.read',
  prescriptions: 'prescription.read',
  appointments: 'appointment.read',
  patients: 'patient.read',
  reports: 'report.read',
  notifications: 'notification.read',
  team: null,
  locations: null,
  voice: 'voice.read',
  settings: 'settings.read',
  medicines: null,
  // A reviewer, a company's staff, or a clinic's doctors and medicine manager.
  submissions: ['submission.review', 'drug.submit', 'drug.propose'],
  // Clinic members only; sent to every open socket and filtered here.
  announcements: 'announcement.view',
};

const mayHear = (connection: Connection, message: RealtimeServerMessage): boolean => {
  const needed = message.type === 'changed' ? TOPIC_READ[message.topic] : null;
  if (needed === null) {
    return true;
  }
  return (typeof needed === 'string' ? [needed] : needed).some((action) => can(connection.role, action));
};

const audienceOf = (audience: Audience): Connection[] => {
  switch (audience.to) {
    case 'location':
      return onLocation(audience.locationId);
    case 'member':
      return ofMember(audience.practiceId, audience.userId);
    case 'session':
      return onSession(audience.sessionId);
    case 'practice':
      return inPractice(audience.practiceId);
    case 'patient': {
      const linkedTo = audience.linkedTo.map((id) => new Types.ObjectId(id));
      return inPractice(audience.practiceId).filter((connection) => canSeePatient(connection.allowedLocationIds, linkedTo));
    }
    case 'all':
      return everyConnection();
    default:
      return [];
  }
};

const changeAccess = ({ practiceId, userId, role, locationIds }: Extract<Delivery, { kind: 'access' }>): void => {
  ofMember(practiceId, userId).forEach((connection) => {
    const nextRole = role ?? connection.role;
    const allowed = allowedLocationsFor(
      nextRole,
      locationIds.map((id) => new Types.ObjectId(id)),
    );
    const { locationId } = connection.who;
    if (allowed !== 'all' && locationId && !allowed.some((id) => id.equals(locationId))) {
      closeConnection(connection, 'LOCATION_NOT_ALLOWED', 'You no longer work at this location.');
      return;
    }
    connection.setAccess(nextRole, allowed);
  });
};

/** Carry out a delivery against the connections open in this process. */
export const deliverHere = (delivery: Delivery): void => {
  if (delivery.kind === 'access') {
    changeAccess(delivery);
    return;
  }

  const connections = audienceOf(delivery.audience);
  if (delivery.kind === 'send') {
    connections
      .filter((connection) => mayHear(connection, delivery.message))
      .forEach((connection) => sendTo(connection.socket, delivery.message));
  } else {
    connections.forEach((connection) => closeConnection(connection, delivery.code, delivery.message));
  }
};

/**
 * The one way anything a write causes reaches a socket.
 *
 * Today that is straight to this process's connections, because there is one
 * process. With more than one, a socket may be held by a process other than
 * the one that handled the write, so this becomes a publish to a Redis
 * channel, every process subscribes and calls deliverHere with what arrives,
 * and nothing that calls deliver changes. That is why a delivery is plain
 * data.
 *
 * What a socket is told about itself - ready, heartbeat, a token that ran
 * out, a sign-in that failed - is local by nature and does not come through
 * here.
 */
export const deliver = (delivery: Delivery): void => {
  deliverHere(delivery);
};
