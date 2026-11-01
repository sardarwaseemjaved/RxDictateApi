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

/** Turn an upgrade down with a plain HTTP status, before any WebSocket exists. */
const turnDown = (socket: Duplex, status: 403 | 404, text: string): void => {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
};

/**
 * Live updates on the HTTP server the API already listens on.
 *
 * Only REALTIME_PATH is upgraded. A browser always sends an Origin, which has
 * to be one CORS allows; the mobile app sends none and is let through, the
 * same rule the HTTP API applies. Nothing about who is calling is read from
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
    const { origin } = request.headers;
    if (origin && !config.cors.origins.includes(origin)) {
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
