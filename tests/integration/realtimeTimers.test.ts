import setupTestDB from '../utils/setupTestDB';
import { aClinic } from '../fixtures/clinic.fixture';
import { connect, realPause, signedIn, startLive, type Live, type LiveClient } from '../fixtures/realtime.fixture';
import { REALTIME_AUTH_TIMEOUT_MS, REALTIME_HEARTBEAT_MS } from '../../src/shared/realtime.schema';

setupTestDB();
jest.setTimeout(30_000);

/**
 * Only setTimeout and setInterval are faked. The clock, promises and I/O stay
 * real, because the database and the sockets under test run on them.
 */
const fakeTimers = () =>
  jest.useFakeTimers({
    doNotFake: ['Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate'],
  });

let live: Live | undefined;

afterEach(async () => {
  await live?.close();
  live = undefined;
  jest.useRealTimers();
});

const heartbeats = (client: LiveClient) => client.inbox.filter((message) => message.type === 'heartbeat').length;

describe('Realtime timers', () => {
  test('a socket that does not sign in within REALTIME_AUTH_TIMEOUT_MS is closed', async () => {
    // The server is started under fake timers, so its timers are the fake ones.
    fakeTimers();
    live = await startLive();
    const client = await connect(live.url);

    jest.advanceTimersByTime(REALTIME_AUTH_TIMEOUT_MS - 1);
    await realPause(50);
    expect(client.isOpen).toBe(true);

    jest.advanceTimersByTime(1);
    expect(await client.next((message) => message.type === 'error')).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await client.closed).toEqual({ code: 1008, reason: 'UNAUTHENTICATED' });
  });

  test('a heartbeat goes out every REALTIME_HEARTBEAT_MS, and a socket that stops answering pings is terminated', async () => {
    const { doctor } = await aClinic('+9230074201');
    fakeTimers();
    live = await startLive();
    const healthy = await signedIn(live.url, doctor, doctor.locationId);
    const silent = await signedIn(live.url, doctor, doctor.locationId, { autoPong: false });

    jest.advanceTimersByTime(REALTIME_HEARTBEAT_MS - 1);
    await realPause(50);
    expect(heartbeats(healthy)).toBe(0);

    // Two pings go unanswered by the silent one; both still get the message.
    jest.advanceTimersByTime(1);
    await Promise.all([healthy, silent].map((client) => client.until(() => heartbeats(client) === 1)));
    await realPause(50);

    jest.advanceTimersByTime(REALTIME_HEARTBEAT_MS);
    await Promise.all([healthy, silent].map((client) => client.until(() => heartbeats(client) === 2)));
    await realPause(50);

    // The third finds two pongs missing.
    jest.advanceTimersByTime(REALTIME_HEARTBEAT_MS);
    expect((await silent.closed).code).toBe(1006);
    await healthy.until(() => heartbeats(healthy) === 3);
    expect(healthy.isOpen).toBe(true);
    expect(heartbeats(silent)).toBe(2);
  });
});
