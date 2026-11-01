import type { RawData, WebSocket } from 'ws';
import logger from '../../config/logger';
import { authenticate } from '../../middlewares/requireAuth';
import {
  REALTIME_AUTH_TIMEOUT_MS,
  realtimeClientMessageSchema,
  type RealtimeClientMessage,
} from '../../shared/realtime.schema';
import { AppError, isAppError } from '../errors';
import { checkLocation, practiceContextFor } from '../tenancy';
import { closeConnection, refuse, sendTo } from './deliver';
import { Connection, register, unregister } from './registry';

/** setTimeout's ceiling. An access token never lives this long, but a bad clock should not wrap the timer. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The one message an app sends, or null for anything else - which is ignored, not answered. */
const parse = (data: RawData): RealtimeClientMessage | null => {
  try {
    const parsed = realtimeClientMessageSchema.safeParse(JSON.parse(String(data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * The checks an HTTP request to a location-scoped route gets - requireAuth,
 * resolvePractice, resolveLocation - run as the same functions, so a socket
 * is refused with exactly the code that request would have been.
 */
const check = async (message: RealtimeClientMessage) => {
  const auth = await authenticate(message.token);
  const ctx = await practiceContextFor(auth.userId, message.practiceId);
  const locationId = await checkLocation(ctx, message.locationId);
  if (locationId instanceof AppError) {
    throw locationId;
  }
  return { auth, ctx, locationId };
};

/**
 * One socket, from connecting to closing.
 *
 * The first `auth` signs it in: on success it is registered and told
 * `ready`, and only then can anything else reach it. Each later `auth`
 * carries the fresh access token the app got by refreshing; it must be the
 * same person, session, clinic and location, and it moves the expiry on. A
 * socket whose token runs out with no fresh one is told TOKEN_EXPIRED and
 * closed, and the app refreshes and reconnects.
 *
 * Messages are handled one at a time, so a refresh can never overtake the
 * sign-in it follows.
 */
export const handleSocket = (socket: WebSocket): void => {
  let connection: Connection | undefined;
  let expiry: NodeJS.Timeout | undefined;
  let queue = Promise.resolve();

  const signInTimer = setTimeout(() => {
    if (!connection) {
      refuse(socket, 'UNAUTHENTICATED', `Sign in within ${REALTIME_AUTH_TIMEOUT_MS / 1000} seconds of connecting.`);
    }
  }, REALTIME_AUTH_TIMEOUT_MS);

  const expireAt = (expiresAt: Date): void => {
    clearTimeout(expiry);
    expiry = setTimeout(
      () => {
        if (connection) {
          closeConnection(connection, 'TOKEN_EXPIRED', 'Your session needs refreshing.');
        }
      },
      Math.min(Math.max(0, expiresAt.getTime() - Date.now()), MAX_TIMER_MS),
    );
  };

  const signIn = async (message: RealtimeClientMessage): Promise<void> => {
    const { auth, ctx, locationId } = await check(message);
    if (socket.readyState !== socket.OPEN) {
      return;
    }

    clearTimeout(signInTimer);
    connection = new Connection(
      socket,
      {
        userId: String(auth.userId),
        sessionId: auth.sessionId,
        practiceId: String(ctx.practiceId),
        membershipId: String(ctx.membershipId),
        locationId: String(locationId),
      },
      ctx.role,
      ctx.allowedLocationIds,
    );
    register(connection);
    expireAt(auth.expiresAt);
    sendTo(socket, { type: 'ready' });
  };

  const refresh = async (current: Connection, message: RealtimeClientMessage): Promise<void> => {
    const { who } = current;
    if (message.practiceId !== who.practiceId || message.locationId !== who.locationId) {
      closeConnection(current, 'VALIDATION_ERROR', 'A different clinic or location needs a new connection.');
      return;
    }

    const { auth, ctx } = await check(message);
    if (String(auth.userId) !== who.userId || auth.sessionId !== who.sessionId) {
      closeConnection(current, 'TOKEN_INVALID', 'That token belongs to a different sign-in.');
      return;
    }

    current.setAccess(ctx.role, ctx.allowedLocationIds);
    expireAt(auth.expiresAt);
  };

  const handle = async (message: RealtimeClientMessage): Promise<void> => {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    try {
      await (connection ? refresh(connection, message) : signIn(message));
    } catch (error) {
      if (!isAppError(error)) {
        logger.error(`realtime sign-in failed: ${(error as Error).message}`);
      }
      const { code, message: text } = isAppError(error) ? error : new AppError('INTERNAL', 'Something went wrong');
      if (connection) {
        closeConnection(connection, code, text);
      } else {
        refuse(socket, code, text);
      }
    }
  };

  socket.on('message', (data, isBinary) => {
    const message = isBinary ? null : parse(data);
    if (message) {
      queue = queue.then(() => handle(message));
    }
  });

  socket.on('close', () => {
    clearTimeout(signInTimer);
    clearTimeout(expiry);
    if (connection) {
      unregister(connection);
    }
  });

  socket.on('error', (error) => {
    // A client that vanished mid-frame, or one that sent more than maxPayload.
    logger.debug(`realtime socket error: ${error.message}`);
  });
};
