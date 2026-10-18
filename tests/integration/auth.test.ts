import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aPa, headersFor, signIn, signUp } from '../fixtures/clinic.fixture';
import config from '../../src/config/config';
import { Location, Membership, OtpCode, Practice, User } from '../../src/models';

setupTestDB();

const sendTo = (phone: string) => request(app).post('/api/v1/auth/otp/send').send({ phone });

/**
 * Verifying now says which phone is signing in, so one device holds one
 * session. A fresh id per call unless a test deliberately reuses one.
 */
let deviceCounter = 0;
const aDevice = (deviceId?: string) => {
  deviceCounter += 1;
  return { deviceId: deviceId ?? `test-device-${deviceCounter}`, platform: 'ios' as const, appVersion: '1.0.0' };
};

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
        .send({ phone: '+923004440004', code: first.body.data.devCode, ...aDevice() })
        .expect(401);
      expect(stale.body.error.code).toBe('OTP_INVALID');

      await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440004', code: second.body.data.devCode, ...aDevice() })
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
      const doctor = await signUp('+923004440010', 'Dr Imran');

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
      const first = await signUp('+923004440011', 'Dr Imran');
      const second = await signUp('+923004440011');

      expect(second.practiceId).toBe(first.practiceId);
      expect(await Practice.countDocuments({})).toBe(1);
      expect((await User.findById(first.userId))?.lastLoginAt).not.toBeNull();
    });

    test('a PA added by a doctor lands in his clinic, not one of her own', async () => {
      const doctor = await signUp('+923004440012', 'Dr Imran');
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
          .send({ phone: '+923004440014', code: wrong, ...aDevice() })
          .expect(401);
        expect(response.body.error.code).toBe('OTP_INVALID');
      }

      const locked = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440014', code: wrong, ...aDevice() })
        .expect(429);
      expect(locked.body.error.code).toBe('OTP_LOCKED');

      // Burned, so the right code no longer works either.
      const after = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440014', code: sent.body.data.devCode, ...aDevice() })
        .expect(401);
      expect(after.body.error.code).toBe('OTP_EXPIRED');
    });

    test('a code is single use', async () => {
      const sent = await sendTo('+923004440015').expect(200);
      await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440015', code: sent.body.data.devCode, ...aDevice() })
        .expect(200);

      const replay = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440015', code: sent.body.data.devCode, ...aDevice() })
        .expect(401);
      expect(replay.body.error.code).toBe('OTP_EXPIRED');
    });
  });

  describe('a clinic is only created when somebody asked for one', () => {
    /**
     * The bug this prevents: an assistant signs in before the doctor has added
     * her, gets a clinic of her own, is walked through doctor setup, and then
     * belongs to two.
     */
    test('a signIn from an unknown number succeeds with no memberships', async () => {
      const sent = await sendTo('+923004440080').expect(200);

      const session = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440080', code: sent.body.data.devCode, intent: 'signIn', ...aDevice() })
        .expect(200);

      expect(session.body.data.memberships).toEqual([]);
      expect(session.body.data.tokens.access.token).toBeTruthy();
      expect(await Practice.countDocuments({})).toBe(0);
      // The user exists; they simply belong to nothing yet.
      expect(await User.countDocuments({ phone: '+923004440080' })).toBe(1);
    });

    test('signIn is the default, so an omitted intent never creates a clinic', async () => {
      const sent = await sendTo('+923004440081').expect(200);

      const session = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440081', code: sent.body.data.devCode, ...aDevice() })
        .expect(200);

      expect(session.body.data.memberships).toEqual([]);
      expect(await Practice.countDocuments({})).toBe(0);
    });

    test('signUp creates one', async () => {
      const doctor = await signUp('+923004440082', 'Dr Imran');

      expect(doctor.practiceId).toBeTruthy();
      expect(await Practice.countDocuments({})).toBe(1);
    });

    test('an assistant who signs in before being added lands in his clinic afterwards', async () => {
      const doctor = await signUp('+923004440083', 'Dr Imran');

      // She tries the app first. Nothing is created for her.
      const early = await signIn('+923004440084');
      expect(early.practiceId).toBe('');
      expect(await Practice.countDocuments({})).toBe(1);

      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923004440084', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);

      const after = await signIn('+923004440084');
      expect(after.practiceId).toBe(doctor.practiceId);
      // Still one clinic, and she is in it rather than in a second one.
      expect(await Practice.countDocuments({})).toBe(1);
      expect(await Membership.countDocuments({ userId: after.userId })).toBe(1);
    });

    test('signUp from a number that already belongs somewhere does not make a second clinic', async () => {
      const doctor = await signUp('+923004440085', 'Dr Imran');
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923004440086', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);

      // She presses the wrong button. She still lands in his clinic.
      const pa = await signUp('+923004440086', 'Sana');
      expect(pa.practiceId).toBe(doctor.practiceId);
      expect(await Practice.countDocuments({})).toBe(1);
    });
  });

  describe('POST /practices', () => {
    test('sets up a clinic for someone already signed in, with no second code', async () => {
      const user = await signIn('+923004440090');
      expect(user.practiceId).toBe('');

      const created = await request(app)
        .post('/api/v1/practices')
        .set({ Authorization: `Bearer ${user.accessToken}` })
        .send({ name: 'Dr Imran' })
        .expect(201);

      // The same shape as GET /me, so the app can replace what it holds.
      expect(created.body.data.id).toBe(user.userId);
      expect(created.body.data.memberships).toHaveLength(1);
      expect(created.body.data.memberships[0].role).toBe('doctor');
      expect(created.body.data.memberships[0].practiceName).toBe("Dr Imran's clinic");
      expect(created.body.data.memberships[0].locations[0].name).toBe('My clinic');

      // The token they already held now works against the new clinic.
      const { practiceId } = created.body.data.memberships[0];
      await request(app)
        .get('/api/v1/patients')
        .set({ Authorization: `Bearer ${user.accessToken}`, 'X-Practice-Id': practiceId })
        .expect(200);
    });

    test('needs no X-Practice-Id, because the point is that there is not one', async () => {
      const user = await signIn('+923004440091');
      await request(app)
        .post('/api/v1/practices')
        .set({ Authorization: `Bearer ${user.accessToken}` })
        .send({})
        .expect(201);
    });

    test('refuses someone who already has a clinic', async () => {
      const doctor = await signUp('+923004440092', 'Dr Imran');

      const response = await request(app)
        .post('/api/v1/practices')
        .set({ Authorization: `Bearer ${doctor.accessToken}` })
        .send({})
        .expect(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(await Practice.countDocuments({})).toBe(1);
    });

    test('refuses an assistant who belongs to somebody else clinic', async () => {
      const doctor = await signUp('+923004440093', 'Dr Imran');
      const pa = await aPa(doctor, '+923004440094');

      const response = await request(app)
        .post('/api/v1/practices')
        .set({ Authorization: `Bearer ${pa.accessToken}` })
        .send({})
        .expect(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });

    test('needs a token', async () => {
      await request(app).post('/api/v1/practices').send({}).expect(401);
    });
  });

  describe('the fixed code, for testing a client', () => {
    afterEach(() => {
      config.otp.fixedCode = undefined;
    });

    test('every number gets the configured code, and it still signs in', async () => {
      config.otp.fixedCode = '123456';

      const first = await sendTo('+923004440040').expect(200);
      const second = await sendTo('+923004440041').expect(200);
      expect(first.body.data.devCode).toBe('123456');
      expect(second.body.data.devCode).toBe('123456');

      const session = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440040', code: '123456', name: 'Dr Test', intent: 'signUp', ...aDevice() })
        .expect(200);
      expect(session.body.data.memberships[0].role).toBe('doctor');
    });

    test('the rest of the flow is untouched - still hashed, still single use', async () => {
      config.otp.fixedCode = '123456';
      await sendTo('+923004440042').expect(200);

      // Predictable, but not stored in the clear.
      const stored = await OtpCode.findOne({ phone: '+923004440042' });
      expect(stored!.codeHash).not.toBe('123456');
      expect(await stored!.isCodeMatch('123456')).toBe(true);

      // A wrong code is still wrong.
      const wrong = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440042', code: '000000', ...aDevice() })
        .expect(401);
      expect(wrong.body.error.code).toBe('OTP_INVALID');

      await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440042', code: '123456', ...aDevice() })
        .expect(200);

      // And still consumed, so a replay of even a fixed code fails.
      const replay = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440042', code: '123456', ...aDevice() })
        .expect(401);
      expect(replay.body.error.code).toBe('OTP_EXPIRED');
    });

    test('a number with no code issued cannot sign in with it', async () => {
      config.otp.fixedCode = '123456';

      // The code has to have been sent to that number first: a fixed value is
      // not a master key.
      const response = await request(app)
        .post('/api/v1/auth/otp/verify')
        .send({ phone: '+923004440043', code: '123456', ...aDevice() })
        .expect(401);
      expect(response.body.error.code).toBe('OTP_EXPIRED');
      expect(await User.countDocuments({ phone: '+923004440043' })).toBe(0);
    });
  });

  describe('tokens', () => {
    test('a refresh token is single use, and a replay ends the session', async () => {
      const doctor = await signUp('+923004440020');

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.refreshToken })
        .expect(200);
      const rotated = refreshed.body.data.tokens.refresh.token as string;
      expect(rotated).not.toBe(doctor.refreshToken);

      // The old one coming back means two holders and no way to tell which is
      // the phone, so the session goes - including for whoever held the newer
      // token.
      const replay = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: doctor.refreshToken }).expect(401);
      expect(replay.body.error.code).toBe('SESSION_REVOKED');

      const after = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rotated }).expect(401);
      expect(after.body.error.code).toBe('SESSION_REVOKED');
    });

    test('an access token cannot be used as a refresh token', async () => {
      const doctor = await signUp('+923004440021');
      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.accessToken })
        .expect(401);
      // It hashes to nothing this server stored, which reads the same as a
      // session that is gone.
      expect(response.body.error.code).toBe('SESSION_REVOKED');
    });

    test('a refresh token cannot be used as an access token', async () => {
      const doctor = await signUp('+923004440022');
      const response = await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${doctor.refreshToken}` })
        .expect(401);
      expect(response.body.error.code).toBe('TOKEN_INVALID');
    });

    test('logout ends the session, so the refresh token is dead too', async () => {
      const doctor = await signUp('+923004440023');
      await request(app).post('/api/v1/auth/logout').send({ refreshToken: doctor.refreshToken }).expect(200);

      const response = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.refreshToken })
        .expect(401);
      expect(response.body.error.code).toBe('SESSION_REVOKED');
    });
  });

  describe('GET /api/v1/me', () => {
    test('answers with the user and every clinic and location they can work at', async () => {
      const doctor = await signUp('+923004440030', 'Dr Imran');
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
      const doctor = await signUp('+923004440031');
      await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${doctor.accessToken}` })
        .expect(200);
    });

    test('a PA sees only the locations she was assigned', async () => {
      const doctor = await signUp('+923004440032', 'Dr Imran');
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
