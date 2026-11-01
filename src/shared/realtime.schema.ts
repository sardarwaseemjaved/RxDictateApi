import { z } from 'zod';
import { objectIdSchema } from './common';
import { ERROR_CODES } from './errorCodes';

/**
 * Live updates, over one WebSocket per open app.
 *
 * The server says that something changed and never what it changed to: a
 * message names a topic and at most an id, and the app refetches through the
 * ordinary routes. Permissions and who-sees-which-patient stay in one place,
 * and no name, phone or medical detail ever travels over the socket.
 *
 * There is no polling behind it. The app refetches everything it shows on
 * every (re)connect, and the heartbeat is how a dead connection gets noticed.
 */
export const REALTIME_PATH = '/api/v1/realtime';

/** How often the server sends `heartbeat`. Silence for two of these means the connection is gone. */
export const REALTIME_HEARTBEAT_MS = 25_000;

/** An unauthenticated socket is closed after this. */
export const REALTIME_AUTH_TIMEOUT_MS = 10_000;

/** What changed, at the grain the app refetches at. */
export const realtimeTopicSchema = z.enum([
  'visits',
  'vitals',
  'prescriptions',
  'appointments',
  'patients',
  'reports',
  'notifications',
  'team',
  'locations',
  'voice',
]);
export type RealtimeTopic = z.infer<typeof realtimeTopicSchema>;

/**
 * App -> server. The only message an app sends.
 *
 * First within REALTIME_AUTH_TIMEOUT_MS of connecting, and again with each
 * fresh access token after a refresh, which keeps the socket open past the
 * old token's expiry. A later one must name the same clinic and location: a
 * different one means a new connection.
 */
export const realtimeClientMessageSchema = z.object({
  type: z.literal('auth'),
  token: z.string(),
  practiceId: objectIdSchema,
  locationId: objectIdSchema,
});
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>;

/**
 * Server -> app.
 *
 * - `ready`: signed in; nothing else is sent before it.
 * - `heartbeat`: every REALTIME_HEARTBEAT_MS.
 * - `changed`: refetch what shows this topic (and this id, when there is one).
 * - `error`: why the socket is about to close, with the code the same HTTP
 *   request would have answered.
 */
export const realtimeServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('heartbeat') }),
  z.object({ type: z.literal('changed'), topic: realtimeTopicSchema, id: objectIdSchema.optional() }),
  z.object({ type: z.literal('error'), code: z.enum(ERROR_CODES), message: z.string() }),
]);
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>;
