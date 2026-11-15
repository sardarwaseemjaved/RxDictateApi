import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import config from '../../config/config';
import { REALTIME_HEARTBEAT_MS, REALTIME_PATH } from '../../shared/realtime.schema';
import { sendTo } from './deliver';
import { handleSocket } from './handshake';
import { connectionOf } from './registry';

/**
 * Comfortably more than an `auth` message - a token and two ids - and far
 * less than anything worth sending to a server that only ever reads that.
 */
const MAX_PAYLOAD_BYTES = 4 * 1024;

/** Pings in a row a socket may leave unanswered before it is taken for dead. */
const MISSED_PONGS = 2;

export interface RealtimeServer {
  close: () => Promise<void>;
}

/** The `host[:port]` of an Origin, lower case, or null when it isn't a URL. */
const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
};

/** The first value of a header that may have been sent more than once or as a list. */
const firstOf = (value: string | string[] | undefined): string | undefined =>
  (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim().toLowerCase() || undefined;

/**
 * Whether an upgrade's Origin is this server itself: its host is the Host the
 * request was sent to, or behind a trusted proxy, the host the proxy says it
 * forwarded. React Native's WebSocket on iOS sends the API's own address as
 * Origin.
 *
 * Safe to let through: a page's JavaScript cannot set either header on a
 * WebSocket, so a browser on some other site always sends that site as Origin
 * and the API as Host, and they differ. The only page whose Origin matches is
 * one this API serves itself. Anything that isn't a browser can send whatever
 * it likes, Origin included, so Origin was never a defence against those.
 */
export const isOwnOrigin = (request: IncomingMessage, origin: string): boolean => {
  const host = hostOf(origin);
  if (!host) {
    return false;
  }
  const own = [firstOf(request.headers.host)];
  if (config.trustProxy > 0) {
    own.push(firstOf(request.headers['x-forwarded-host']));
  }
  return own.includes(host);
};

/**
 * Whether an upgrade may go ahead. No Origin (the Android app, a server) and
 * this server's own Origin (the iOS app) are let through; a browser's Origin
 * has to be one CORS allows, the same rule the HTTP API applies.
 */
export const allowsUpgradeFrom = (request: IncomingMessage): boolean => {
  const { origin } = request.headers;
  return !origin || config.cors.allowsOrigin(origin) || isOwnOrigin(request, origin);
};

/** Turn an upgrade down with a plain HTTP status, before any WebSocket exists. */
const turnDown = (socket: Duplex, status: 403 | 404, text: string): void => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

/**
 * Live updates on the HTTP server the API already listens on.
 *
 * Only REALTIME_PATH is upgraded. A browser always sends an Origin, which has
 * to be one CORS allows. The mobile app sends none (Android) or the API's own
 * address (iOS), and both are let through: see allowsUpgradeFrom. Nothing
 * about who is calling is read from
 * the URL: the first message signs the socket in (see handshake.ts).
 *
 * Every REALTIME_HEARTBEAT_MS each signed-in socket is sent a `heartbeat`
 * message, which is what lets a browser - which cannot see protocol pings -
 * notice a dead connection. Every socket is also pinged at the protocol level,
 * and one that has left MISSED_PONGS pings unanswered is terminated, so dead
 * sockets do not pile up on the server either.
 */
export const attachRealtime = (server: Server): RealtimeServer => {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const unanswered = new Map<WebSocket, number>();

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname !== REALTIME_PATH) {
      turnDown(socket, 404, 'Not Found');
      return;
    }
    if (!allowsUpgradeFrom(request)) {
      turnDown(socket, 403, 'Forbidden');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws: WebSocket) => {
    unanswered.set(ws, 0);
    ws.on('pong', () => unanswered.set(ws, 0));
    ws.on('close', () => unanswered.delete(ws));
    handleSocket(ws);
  });

  const heartbeat = setInterval(() => {
    unanswered.forEach((missed, ws) => {
      if (missed >= MISSED_PONGS) {
        ws.terminate();
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      unanswered.set(ws, missed + 1);
      ws.ping();
      if (connectionOf(ws)) {
        sendTo(ws, { type: 'heartbeat' });
      }
    });
  }, REALTIME_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    /** On shutdown: 1001, going away. The apps reconnect to whatever comes up next. */
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        server.off('upgrade', onUpgrade);
        wss.clients.forEach((ws) => ws.close(1001, 'Server restarting'));
        wss.close(() => resolve());
      }),
  };
};
