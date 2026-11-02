import { randomBytes } from 'crypto';
import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config/config';
import setupTestDB from '../utils/setupTestDB';

setupTestDB();

/**
 * On its own, because the bucket counts every verify request this file's app
 * has seen: the rest of the suite runs with the limit lifted, and this sets it
 * back to the production default.
 */
describe('The public verify routes', () => {
  const lifted = config.rateLimit.verifyMax;

  afterAll(() => {
    config.rateLimit.verifyMax = lifted;
  });

  test('share one tight bucket per address, and going over it answers RATE_LIMITED', async () => {
    config.rateLimit.verifyMax = 30;
    const code = randomBytes(16).toString('base64url');

    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app).get(`/api/v1/verify/${code}`);
      expect(response.status).toBe(404);
    }

    // The image counts against the same bucket as the page.
    const over = await request(app).get(`/api/v1/verify/${code}/qr.svg`);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('RATE_LIMITED');

    // Its own bucket: the rest of the API is not held up by it.
    const elsewhere = await request(app).get('/api/v1/me');
    expect(elsewhere.status).toBe(401);
  });
});
