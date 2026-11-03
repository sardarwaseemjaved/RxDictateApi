import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config/config';
import setupTestDB from '../utils/setupTestDB';
import { signIn } from '../fixtures/clinic.fixture';

setupTestDB();

/**
 * On its own, because the bucket counts every attempt this file's app has seen:
 * the rest of the suite runs with the limit lifted, and this sets it back to the
 * production default.
 */
describe('Trying a code to link a record', () => {
  const lifted = config.rateLimit.portalLinkMax;

  afterAll(() => {
    config.rateLimit.portalLinkMax = lifted;
  });

  test('both routes share one bucket per person, and going over it answers RATE_LIMITED', async () => {
    config.rateLimit.portalLinkMax = 10;
    const person = await signIn('+923001110001');
    const headers = { Authorization: `Bearer ${person.accessToken}` };
    const body = { kind: 'invite', code: 'A'.repeat(22) };

    for (let i = 0; i < 10; i += 1) {
      const path = i % 2 === 0 ? '/api/v1/portal/links' : '/api/v1/portal/links/preview';
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app).post(path).set(headers).send(body);
      expect(response.body.error.code).toBe('PORTAL_LINK_FAILED');
    }

    const over = await request(app).post('/api/v1/portal/links').set(headers).send(body);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');

    // Somebody else on the same address isn't held up, and neither is reading.
    const other = await signIn('+923001110002');
    const elsewhere = await request(app)
      .post('/api/v1/portal/links')
      .set({ Authorization: `Bearer ${other.accessToken}` })
      .send(body);
    expect(elsewhere.body.error.code).toBe('PORTAL_LINK_FAILED');
    await request(app).get('/api/v1/portal/links').set(headers).expect(200);
  });
});
