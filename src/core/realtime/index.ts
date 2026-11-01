/**
 * Live updates over one WebSocket per open app.
 *
 * - server.ts: the upgrade on REALTIME_PATH, the Origin check, the heartbeat.
 * - handshake.ts: signing a socket in, fresh tokens, expiry.
 * - registry.ts: the open connections, by location, user, session and clinic.
 * - deliver.ts: the one function every message caused by a write goes through.
 *
 * What a write means to whom is decided in src/listeners/realtime.ts.
 */
export { attachRealtime, type RealtimeServer } from './server';
export { deliver, type Audience, type Delivery } from './deliver';
