import type { Types } from 'mongoose';
import type { WebSocket } from 'ws';
import type { Role } from '../../shared/roles';

/** Who a signed-in socket belongs to. Fixed for its life: a different one is a new connection. */
export interface Identity {
  userId: string;
  sessionId: string;
  practiceId: string;
  membershipId: string;
  locationId: string;
}

/**
 * One signed-in socket, and what deliveries are matched against.
 *
 * Ids are strings, because the indexes are keyed by them and a delivery that
 * may one day arrive from another process carries them that way. What the
 * member may reach is the one part that changes while the socket is open:
 * their role or their locations can be edited under them.
 */
export class Connection {
  readonly socket: WebSocket;

  readonly who: Identity;

  role: Role;

  allowedLocationIds: Types.ObjectId[] | 'all';

  constructor(socket: WebSocket, who: Identity, role: Role, allowedLocationIds: Types.ObjectId[] | 'all') {
    this.socket = socket;
    this.who = who;
    this.role = role;
    this.allowedLocationIds = allowedLocationIds;
  }

  /** After the member's role or locations change, so patient updates follow them. */
  setAccess(role: Role, allowedLocationIds: Types.ObjectId[] | 'all'): void {
    this.role = role;
    this.allowedLocationIds = allowedLocationIds;
  }
}

/** Connections under one kind of key. A set per key, because one person may have several devices open. */
const index = () => {
  const sets = new Map<string, Set<Connection>>();
  return {
    add: (key: string, connection: Connection): void => {
      const set = sets.get(key) ?? new Set<Connection>();
      set.add(connection);
      sets.set(key, set);
    },
    remove: (key: string, connection: Connection): void => {
      const set = sets.get(key);
      set?.delete(connection);
      if (set?.size === 0) {
        sets.delete(key);
      }
    },
    get: (key: string): Connection[] => [...(sets.get(key) ?? [])],
  };
};

/**
 * Every open connection in this process, under its location, its user, its
 * session and its clinic. In memory, because there is one process; what
 * changes with a second one is described in deliver.ts.
 */
const byLocation = index();
const byUser = index();
const bySession = index();
const byPractice = index();
const bySocket = new Map<WebSocket, Connection>();

export const register = (connection: Connection): void => {
  const { who } = connection;
  byLocation.add(who.locationId, connection);
  byUser.add(who.userId, connection);
  bySession.add(who.sessionId, connection);
  byPractice.add(who.practiceId, connection);
  bySocket.set(connection.socket, connection);
};

/** Safe to call twice: a socket closed by the server is also reported closed by ws. */
export const unregister = (connection: Connection): void => {
  const { who } = connection;
  byLocation.remove(who.locationId, connection);
  byUser.remove(who.userId, connection);
  bySession.remove(who.sessionId, connection);
  byPractice.remove(who.practiceId, connection);
  bySocket.delete(connection.socket);
};

export const onLocation = (locationId: string): Connection[] => byLocation.get(locationId);

/** One person's connections in one clinic: they may be signed in to another on the same phone. */
export const ofMember = (practiceId: string, userId: string): Connection[] =>
  byUser.get(userId).filter((connection) => connection.who.practiceId === practiceId);

export const onSession = (sessionId: string): Connection[] => bySession.get(sessionId);

export const inPractice = (practiceId: string): Connection[] => byPractice.get(practiceId);

/** The connection a socket signed in as, or undefined while it has not. */
export const connectionOf = (socket: WebSocket): Connection | undefined => bySocket.get(socket);
