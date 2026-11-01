import { once } from 'events';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, type ClientOptions } from 'ws';
import app from '../../src/app';
import { attachRealtime, type RealtimeServer } from '../../src/core/realtime';
import { REALTIME_PATH, type RealtimeServerMessage, type RealtimeTopic } from '../../src/shared/realtime.schema';
import type { SignedIn } from './clinic.fixture';

/**
 * Captured before any test can install fake timers, so waiting on a socket
 * still times out - and still lets real I/O happen - while the server's own
 * timers are faked.
 */
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

/** A real pause, even under fake timers. */
export const realPause = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });

export interface Live {
  url: string;
  close: () => Promise<void>;
}

/** The API on a free port with live updates attached, the way src/index.ts runs it. */
export const startLive = async (): Promise<Live> => {
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const realtime: RealtimeServer = attachRealtime(server);
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}${REALTIME_PATH}`,
    close: async () => {
      await realtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
};

/** One app's socket, and everything it has been sent. */
export class LiveClient {
  readonly ws: WebSocket;

  readonly inbox: RealtimeServerMessage[] = [];

  /** The raw text of every frame, for checking what crossed the wire. */
  readonly frames: string[] = [];

  readonly closed: Promise<{ code: number; reason: string }>;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      this.frames.push(String(data));
      this.inbox.push(JSON.parse(String(data)));
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }));
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  auth(actor: SignedIn, locationId: string, token = actor.accessToken): void {
    this.send({ type: 'auth', token, practiceId: actor.practiceId, locationId });
  }

  /** Resolves once the inbox satisfies `done`, or fails with what did arrive. */
  async until(done: (inbox: RealtimeServerMessage[]) => boolean, timeoutMs = 4000): Promise<void> {
    if (done(this.inbox)) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const check = () => {
        if (done(this.inbox)) {
          realClearTimeout(timer);
          this.ws.off('message', check);
          resolve();
        }
      };
      timer = realSetTimeout(() => {
        this.ws.off('message', check);
        reject(new Error(`timed out; the inbox is ${JSON.stringify(this.inbox)}`));
      }, timeoutMs);
      this.ws.on('message', check);
    });
  }

  async next(match: (message: RealtimeServerMessage) => boolean, timeoutMs?: number): Promise<RealtimeServerMessage> {
    await this.until((inbox) => inbox.some(match), timeoutMs);
    return this.inbox.find(match)!;
  }

  /** The `changed` messages so far, of one topic or all. */
  changes(topic?: RealtimeTopic): Extract<RealtimeServerMessage, { type: 'changed' }>[] {
    return this.inbox.filter(
      (message): message is Extract<RealtimeServerMessage, { type: 'changed' }> =>
        message.type === 'changed' && (topic === undefined || message.topic === topic),
    );
  }
}

/** A socket that has connected and not yet said anything. */
export const connect = async (url: string, options?: ClientOptions): Promise<LiveClient> => {
  const ws = new WebSocket(url, options);
  const client = new LiveClient(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return client;
};

/** A socket signed in as this member at this location, past `ready`. */
export const signedIn = async (url: string, actor: SignedIn, locationId: string, options?: ClientOptions) => {
  const client = await connect(url, options);
  client.auth(actor, locationId);
  await client.next((message) => message.type === 'ready');
  return client;
};
