import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../../src/app';
import config from '../../src/config/config';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, headersFor, signUp, type SignedIn } from '../fixtures/clinic.fixture';
import { AuditLog, Device, Session, User } from '../../src/models';
import { clearSessionCache, markExpiredSessions } from '../../src/services/session.service';
import { hashToken } from '../../src/services/token.service';

setupTestDB();

const logout = (body: Record<string, unknown>, accessToken?: string) => {
  const call = request(app).post('/api/v1/auth/logout');
  return accessToken ? call.set({ Authorization: `Bearer ${accessToken}` }).send(body) : call.send(body);
};

/** An access token for this session that expired an hour ago. */
const expiredAccessToken = (userId: string, sessionId: string) =>
  jwt.sign({ sub: userId, sid: sessionId, type: 'access' }, config.jwt.secret, { expiresIn: -3600 });

const sessionOf = async (actor: SignedIn) => {
  const session = await Session.findOne({ refreshTokenHash: hashToken(actor.refreshToken) });
  if (!session) throw new Error('no session was created for that sign-in');
  return session;
};

/**
 * An access token is a signed claim that cannot be withdrawn, so without a
 * session record on this side a phone that signed out keeps working until its
 * token happens to expire. These cover the record that closes that.
 */
describe('Signing out', () => {
  test('revokes the session, and the same access token is then refused everywhere', async () => {
    const { doctor } = await aClinic('+923012220001');

    await request(app)
      .get('/api/v1/me')
      .set({ Authorization: `Bearer ${doctor.accessToken}` })
      .expect(200);

    await logout({ refreshToken: doctor.refreshToken }, doctor.accessToken).expect(200);

    // The token is still signed and unexpired. The session behind it is not.
    const me = await request(app)
      .get('/api/v1/me')
      .set({ Authorization: `Bearer ${doctor.accessToken}` })
      .expect(401);
    expect(me.body.error.code).toBe('SESSION_REVOKED');

    const scoped = await request(app).get('/api/v1/patients').set(headersFor(doctor)).expect(401);
    expect(scoped.body.error.code).toBe('SESSION_REVOKED');

    const session = await sessionOf(doctor);
    expect(session.revokedAt).not.toBeNull();
    expect(session.revokedReason).toBe('logout');
  });

  test('is idempotent: a second call answers the same way', async () => {
    const { doctor } = await aClinic('+923012220002');

    await logout({ refreshToken: doctor.refreshToken }, doctor.accessToken).expect(200);
    const again = await logout({ refreshToken: doctor.refreshToken }, doctor.accessToken).expect(200);
    expect(again.body.data.signedOut).toBe(true);

    // And the reason stays the first one, which is the true one.
    expect((await sessionOf(doctor)).revokedReason).toBe('logout');
  });

  test('never fails, even with no credential the server recognises', async () => {
    await logout({}).expect(200);
    await logout({ refreshToken: 'not-a-token-this-server-issued' }).expect(200);
    await logout({}, 'not.a.jwt').expect(200);
  });

  test('works with an expired access token and a valid refresh token', async () => {
    const { doctor } = await aClinic('+923012220003');
    const session = await sessionOf(doctor);
    const stale = expiredAccessToken(doctor.userId, String(session._id));

    // That token is refused everywhere else, and says why.
    const refused = await request(app)
      .get('/api/v1/me')
      .set({ Authorization: `Bearer ${stale}` })
      .expect(401);
    expect(refused.body.error.code).toBe('TOKEN_EXPIRED');

    // But it is still enough to sign out cleanly, which is the point: a phone
    // that was asleep must not leave a live session behind.
    await logout({ refreshToken: doctor.refreshToken }, stale).expect(200);
    expect((await sessionOf(doctor)).revokedReason).toBe('logout');
  });

  test('works from the refresh token alone', async () => {
    const { doctor } = await aClinic('+923012220004');

    await logout({ refreshToken: doctor.refreshToken }).expect(200);
    expect((await sessionOf(doctor)).revokedAt).not.toBeNull();
  });

  test('refreshing after signing out is refused', async () => {
    const { doctor } = await aClinic('+923012220005');
    await logout({ refreshToken: doctor.refreshToken }, doctor.accessToken).expect(200);

    const response = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: doctor.refreshToken }).expect(401);
    expect(response.body.error.code).toBe('SESSION_REVOKED');
  });

  test('clears this phone push token, and does not mind if there is none', async () => {
    const { doctor } = await aClinic('+923012220006');
    const session = await sessionOf(doctor);

    await Device.create({
      userId: session.userId,
      deviceId: session.deviceId,
      pushToken: 'expo-push-token-for-this-phone',
      platform: 'ios',
    });
    // Another phone's token, which must survive.
    await Device.create({
      userId: session.userId,
      deviceId: 'some-other-phone',
      pushToken: 'expo-push-token-for-another-phone',
      platform: 'android',
    });

    await logout({ refreshToken: doctor.refreshToken }, doctor.accessToken).expect(200);

    expect(await Device.countDocuments({ userId: session.userId, deviceId: session.deviceId })).toBe(0);
    expect(await Device.countDocuments({ userId: session.userId, deviceId: 'some-other-phone' })).toBe(1);
  });

  describe('one phone, one session', () => {
    test('verifying again on the same device retires the earlier session', async () => {
      const first = await signUp('+923012220010', 'Dr Imran', 'the-same-phone');
      const firstSession = await sessionOf(first);

      const second = await signUp('+923012220010', undefined, 'the-same-phone');

      expect(String((await sessionOf(second))._id)).not.toBe(String(firstSession._id));

      const retired = await Session.findById(firstSession._id);
      expect(retired?.revokedReason).toBe('logout');

      // The first phone's token no longer works; the new one does.
      clearSessionCache();
      await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${first.accessToken}` })
        .expect(401);
      await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${second.accessToken}` })
        .expect(200);
    });

    test('signing out on one device leaves the other alone', async () => {
      const phone = await signUp('+923012220011', 'Dr Imran', 'device-phone-a');
      const tablet = await signUp('+923012220011', undefined, 'device-phone-b');

      // Two live sessions for one person, on two devices.
      expect(await Session.countDocuments({ userId: phone.userId, revokedAt: null })).toBe(2);

      await logout({ refreshToken: phone.refreshToken }, phone.accessToken).expect(200);
      clearSessionCache();

      const signedOut = await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${phone.accessToken}` })
        .expect(401);
      expect(signedOut.body.error.code).toBe('SESSION_REVOKED');

      await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${tablet.accessToken}` })
        .expect(200);
      await request(app).post('/api/v1/auth/refresh').send({ refreshToken: tablet.refreshToken }).expect(200);
    });
  });

  describe('a rotated token coming back', () => {
    test('ends the session, recorded as reuse', async () => {
      const { doctor } = await aClinic('+923012220020');

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.refreshToken })
        .expect(200);
      const rotated = refreshed.body.data.tokens.refresh.token as string;

      await request(app).post('/api/v1/auth/refresh').send({ refreshToken: doctor.refreshToken }).expect(401);

      const session = await Session.findOne({ refreshTokenFamily: { $exists: true }, userId: doctor.userId });
      expect(session?.revokedReason).toBe('reuse_detected');

      // Whoever held the newer token loses it too: there is no telling which
      // holder is the phone.
      await request(app).post('/api/v1/auth/refresh').send({ refreshToken: rotated }).expect(401);

      clearSessionCache();
      const access = await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${refreshed.body.data.tokens.access.token}` })
        .expect(401);
      expect(access.body.error.code).toBe('SESSION_REVOKED');
    });

    test('a token from a session that was signed out keeps the sign-out reason', async () => {
      const { doctor } = await aClinic('+923012220021');
      await logout({ refreshToken: doctor.refreshToken }).expect(200);

      await request(app).post('/api/v1/auth/refresh').send({ refreshToken: doctor.refreshToken }).expect(401);
      expect((await sessionOf(doctor)).revokedReason).toBe('logout');
    });
  });

  describe('the audit trail', () => {
    test('records the sign-out against the clinic, with no token in it', async () => {
      const { doctor } = await aClinic('+923012220030');
      const session = await sessionOf(doctor);

      await logout({ refreshToken: doctor.refreshToken }, doctor.accessToken).expect(200);

      const entries = await AuditLog.find({ action: 'auth.logout' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entity: 'session',
        role: 'doctor',
      });
      expect(String(entries[0].entityId)).toBe(String(session._id));
      expect(String(entries[0].actorId)).toBe(doctor.userId);
      expect(String(entries[0].practiceId)).toBe(doctor.practiceId);

      // Device and platform, and nothing that could be replayed.
      const written = JSON.stringify(entries[0].toObject());
      expect(written).toContain(session.deviceId);
      expect(written).not.toContain(doctor.refreshToken);
      expect(written).not.toContain(doctor.accessToken);
      expect(written).not.toContain(session.refreshTokenHash);
    });

    test('a PA on two clinics is recorded against both', async () => {
      const first = await aClinic('+923012220031');
      const second = await aClinic('+923012220032');
      const pa = await aPa(first.doctor, '+923012220033');
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(second.doctor))
        .send({ phone: '+923012220033', role: 'pa', locationIds: [second.doctor.locationId] })
        .expect(201);

      await logout({ refreshToken: pa.refreshToken }, pa.accessToken).expect(200);

      const entries = await AuditLog.find({ action: 'auth.logout' });
      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => String(entry.practiceId)).sort()).toEqual(
        [first.doctor.practiceId, second.doctor.practiceId].sort(),
      );
    });
  });

  describe('what is stored', () => {
    test('no raw refresh token is ever on the session document', async () => {
      const { doctor } = await aClinic('+923012220040');
      const session = await sessionOf(doctor);

      const stored = JSON.stringify(session.toObject());
      expect(stored).not.toContain(doctor.refreshToken);
      // The hash is a hash, and the plugin keeps it out of anything serialised.
      expect(session.refreshTokenHash).toBe(hashToken(doctor.refreshToken));
      expect(JSON.stringify(session.toJSON())).not.toContain(session.refreshTokenHash);
    });

    test('the sign-in response is the only place the refresh token appears', async () => {
      const { doctor } = await aClinic('+923012220041');

      const user = await User.findById(doctor.userId);
      expect(JSON.stringify(user?.toObject())).not.toContain(doctor.refreshToken);

      const sessions = await Session.find({ userId: doctor.userId });
      sessions.forEach((session) => {
        expect(JSON.stringify(session.toObject())).not.toContain(doctor.refreshToken);
      });
    });
  });

  describe('expiry', () => {
    test('a session past its expiry reads as ended, and the sweep records it', async () => {
      const { doctor } = await aClinic('+923012220050');
      const session = await sessionOf(doctor);

      await Session.updateOne({ _id: session._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      clearSessionCache();

      const response = await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${doctor.accessToken}` })
        .expect(401);
      expect(response.body.error.code).toBe('SESSION_EXPIRED');

      const refresh = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.refreshToken })
        .expect(401);
      expect(refresh.body.error.code).toBe('SESSION_EXPIRED');

      expect(await markExpiredSessions()).toBeGreaterThanOrEqual(0);
      expect((await Session.findById(session._id))?.revokedReason).toBe('expired');
    });

    test('refreshing slides the expiry, but not past the hard limit', async () => {
      const { doctor } = await aClinic('+923012220051');
      const session = await sessionOf(doctor);

      // Signed in 89 days ago, with a 90 day ceiling. Through the driver,
      // because mongoose makes createdAt immutable and would drop this.
      const createdAt = new Date(Date.now() - 89 * 86_400_000);
      await Session.collection.updateOne({ _id: session._id }, { $set: { createdAt } });

      const refreshed = await request(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: doctor.refreshToken })
        .expect(200);

      const slid = new Date(refreshed.body.data.tokens.refresh.expires).getTime();
      const ceiling = createdAt.getTime() + config.session.maxDays * 86_400_000;
      // A phone refreshing every day cannot keep one sign-in alive forever.
      expect(slid).toBeLessThanOrEqual(ceiling + 1000);
      expect(slid).toBeLessThan(Date.now() + config.session.expirationDays * 86_400_000);
    });
  });

  describe('POST /auth/logout-all', () => {
    test('is mounted, authenticated and answers 501 for now', async () => {
      const { doctor } = await aClinic('+923012220060');

      const response = await request(app)
        .post('/api/v1/auth/logout-all')
        .set({ Authorization: `Bearer ${doctor.accessToken}` })
        .send({})
        .expect(501);
      expect(response.body.error.code).toBe('NOT_IMPLEMENTED');

      // Behind the real auth chain, so the shape is settled.
      await request(app).post('/api/v1/auth/logout-all').send({}).expect(401);
    });
  });
});
