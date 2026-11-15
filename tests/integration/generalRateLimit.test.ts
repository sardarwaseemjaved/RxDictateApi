import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config/config';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, type SignedIn } from '../fixtures/clinic.fixture';

setupTestDB();

/**
 * On its own, because the general bucket counts every request this file's app
 * has seen: the rest of the suite runs with the limit lifted. Every request
 * here comes from one address, as a clinic's reception and doctor usually do.
 */
describe('The general rate limit', () => {
  const lifted = config.rateLimit.max;
  const LIMIT = 10;

  afterAll(() => {
    config.rateLimit.max = lifted;
  });

  const me = (token?: string) =>
    request(app)
      .get('/api/v1/me')
      .set(token ? { Authorization: `Bearer ${token}` } : {});

  /** Requests until the first refusal; answers how many got through. */
  const untilRefused = async (token?: string): Promise<number> => {
    for (let sent = 0; sent <= LIMIT; sent += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await me(token);
      if (response.status === 429) {
        expect(response.body.error.code).toBe('RATE_LIMITED');
        return sent;
      }
    }
    throw new Error(`never refused after ${LIMIT + 1} requests`);
  };

  test('counts each signed-in person on their own, and anonymous requests by address', async () => {
    // Signing in is anonymous, so it is counted against the address before the limit is tightened.
    const { doctor: first } = await aClinic('+923019900001');
    const { doctor: second } = await aClinic('+923019900002');
    config.rateLimit.max = LIMIT;

    // Anonymous: one bucket for the address, used up here.
    expect(await untilRefused()).toBeLessThanOrEqual(LIMIT);
    await me().expect(429);

    // Two people at that same address each still have their own allowance. Each has
    // spent one request already: setting up their clinic added a patient as them.
    expect(await untilRefused(first.accessToken)).toBe(LIMIT - 1);
    await me(second.accessToken).expect(200);
    expect(await untilRefused(second.accessToken)).toBe(LIMIT - 2);
  });

  test("a token this API didn't sign counts against the address, so inventing subjects buys nothing", async () => {
    config.rateLimit.max = lifted;
    const { doctor } = await aClinic('+923019900003');
    config.rateLimit.max = LIMIT;
    const forged = (sub: string) => jwt.sign({ sub, sid: 'x', type: 'access' }, 'not-the-secret-not-the-secret');

    // Spend the address's bucket; a forged token is then refused at once, whatever subject it names.
    await untilRefused();
    await me(forged('a'.repeat(24))).expect(429);
    await me(forged('b'.repeat(24))).expect(429);

    // A lapsed token of ours still names its person: it counts against them, not the address.
    const lapsed = jwt.sign(
      { sub: (doctor as SignedIn).userId, sid: 'x', type: 'access', exp: Math.floor(Date.now() / 1000) - 60 },
      config.jwt.secret,
    );
    const response = await me(lapsed);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('TOKEN_EXPIRED');
  });
});
