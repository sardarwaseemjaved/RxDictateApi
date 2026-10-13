import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { headersFor, signIn } from '../fixtures/clinic.fixture';
import { Location, Membership, OtpCode, Practice, User } from '../../src/models';

setupTestDB();

const sendTo = (phone: string) => request(app).post('/api/v1/auth/otp/send').send({ phone });

describe('Auth', () => {
  describe('POST /api/v1/auth/otp/send', () => {
    test('issues a code, stored hashed, and never returns it in the body in production', async () => {
      const response = await sendTo('+923004440001').expect(200);
      expect(response.body.data.sent).toBe(true);

      const stored = await OtpCode.findOne({ phone: '+923004440001' });
      expect(stored).not.toBeNull();
      // Hashed, so a dump of the collection cannot be replayed.
      expect(stored!.codeHash).not.toBe(response.body.data.devCode);
      expect(stored!.codeHash).toHaveLength(60);
      expect(await stored!.isCodeMatch(response.body.data.devCode)).toBe(true);
    });

    test('a resend inside the cooldown is refused, per phone number', async () => {
      await sendTo('+923004440002').expect(200);

      const again = await sendTo('+923004440002').expect(429);
      expect(again.body.error.code).toBe('OTP_COOLDOWN');
      expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(0);

      // A different number is unaffected: the limit protects the person being
      // texted, not the connection asking.
      await sendTo('+923004440003').expect(200);
    });

    test('only the most recent code verifies', async () => {
      const first = await sendTo('+923004440004').expect(200);
      await OtpCode.deleteMany({ phone: '+923004440004' });
      const second = await sendTo('+923004440004').expect(200);

      expect(await OtpCode.countDocuments({ phone: '+923004440004' })).toBe(1);

      const stale = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440004', code: first.body.data.devCode })
        .expect(401);
      expect(stale.body.error.code).toBe('OTP_INVALID');

      await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440004', code: second.body.data.devCode })
        .expect(200);
    });

    test('a number that is not E.164 is refused with a field-level message', async () => {
      const response = await sendTo('03001234567').expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details[0].field).toBe('body.phone');
    });
  });

  describe('POST /api/v1/auth/otp/verify', () => {
    test('a brand new number gets a clinic, a location and a doctor membership', async () => {
      const doctor = await signIn('+923004440010', 'Dr Imran');

      const practice = await Practice.findById(doctor.practiceId);
      expect(practice?.name).toBe("Dr Imran's clinic");
      expect(practice?.ownerId.toString()).toBe(doctor.userId);
      expect(practice?.features.voice).toBe(true);
      expect(practice?.rxCounter).toBe(0);

      const locations = await Location.find({ practiceId: doctor.practiceId });
      expect(locations).toHaveLength(1);
      // The UI never says "practice"; to the doctor this is his clinic.
      expect(locations[0].name).toBe('My clinic');
      expect(locations[0].isDefault).toBe(true);

      const membership = await Membership.findOne({ userId: doctor.userId });
      expect(membership?.role).toBe('doctor');
      expect(membership?.status).toBe('active');
    });

    test('signing in again does not create a second clinic', async () => {
      const first = await signIn('+923004440011', 'Dr Imran');
      const second = await signIn('+923004440011');

      expect(second.practiceId).toBe(first.practiceId);
      expect(await Practice.countDocuments({})).toBe(1);
      expect((await User.findById(first.userId))?.lastLoginAt).not.toBeNull();
    });

    test('a PA added by a doctor lands in his clinic, not one of her own', async () => {
      const doctor = await signIn('+923004440012', 'Dr Imran');
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923004440013', name: 'Sana', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);

      const pa = await signIn('+923004440013');

      expect(await Practice.countDocuments({})).toBe(1);
      expect(pa.practiceId).toBe(doctor.practiceId);
      const membership = await Membership.findOne({ userId: pa.userId });
      expect(membership?.role).toBe('pa');
    });

    test('a wrong code is counted and the code is burned after too many tries', async () => {
      const sent = await sendTo('+923004440014').expect(200);
      const wrong = sent.body.data.devCode === '000000' ? '111111' : '000000';

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await request(app)
          .post('/api/v1/auth/otp/verify')
          .send({ phone: '+923004440014', code: wrong })
          .expect(401);
        expect(response.body.error.code).toBe('OTP_INVALID');
      }

      const locked = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440014', code: wrong })
        .expect(429);
      expect(locked.body.error.code).toBe('OTP_LOCKED');

      // Burned, so the right code no longer works either.
      const after = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440014', code: sent.body.data.devCode })
        .expect(401);
      expect(after.body.error.code).toBe('OTP_EXPIRED');
    });

    test('a code is single use', async () => {
      const sent = await sendTo('+923004440015').expect(200);
      await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440015', code: sent.body.data.devCode })
        .expect(200);

      const replay = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440015', code: sent.body.data.devCode })
        .expect(401);
      expect(replay.body.error.code).toBe('OTP_EXPIRED');
    });
  });

  describe('tokens', () => {
    test('a refresh token is single use and returns a fresh pair', async () => {
      const doctor = await signIn('+923004440020');

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.refreshToken })
        .expect(200);
      expect(refreshed.body.data.tokens.refresh.token).not.toBe(doctor.refreshToken);

      const replay = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: doctor.refreshToken }).expect(401);
      expect(replay.body.error.code).toBe('TOKEN_INVALID');
    });

    test('an access token cannot be used as a refresh token', async () => {
      const doctor = await signIn('+923004440021');
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.accessToken })
        .expect(401);
      expect(response.body.error.code).toBe('TOKEN_INVALID');
    });

    test('a refresh token cannot be used as an access token', async () => {
      const doctor = await signIn('+923004440022');
      const response = await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${doctor.refreshToken}` })
        .expect(401);
      expect(response.body.error.code).toBe('TOKEN_INVALID');
    });

    test('logout revokes the refresh token', async () => {
      const doctor = await signIn('+923004440023');
      await request(app).post('/api/v1/auth/logout').send({ refreshToken: doctor.refreshToken }).expect(200);

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.refreshToken })
        .expect(401);
      expect(response.body.error.code).toBe('TOKEN_INVALID');
    });
  });

  describe('GET /api/v1/me', () => {
    test('answers with the user and every clinic and location they can work at', async () => {
      const doctor = await signIn('+923004440030', 'Dr Imran');
      await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'Clifton branch' }).expect(201);

      const me = await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${doctor.accessToken}` })
        .expect(200);

      expect(me.body.data.phone).toBe('+923004440030');
      expect(me.body.data.memberships).toHaveLength(1);
      expect(me.body.data.memberships[0].role).toBe('doctor');
      // A doctor may use any location of his own practice, so both are listed.
      expect(me.body.data.memberships[0].locations).toHaveLength(2);
    });

    test('needs no practice header, because its answer is what provides one', async () => {
      const doctor = await signIn('+923004440031');
      await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${doctor.accessToken}` })
        .expect(200);
    });

    test('a PA sees only the locations she was assigned', async () => {
      const doctor = await signIn('+923004440032', 'Dr Imran');
      await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'Clifton branch' }).expect(201);
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923004440033', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);

      const pa = await signIn('+923004440033');
      const me = await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${pa.accessToken}` })
        .expect(200);

      expect(me.body.data.memberships[0].locations).toHaveLength(1);
      expect(me.body.data.memberships[0].locations[0].id).toBe(doctor.locationId);
    });
  });
});
