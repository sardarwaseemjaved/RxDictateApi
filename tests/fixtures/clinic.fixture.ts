import request from 'supertest';
import app from '../../src/app';

export interface SignedIn {
  userId: string;
  phone: string;
  accessToken: string;
  refreshToken: string;
  practiceId: string;
  locationId: string;
}

export interface Headers extends Record<string, string> {
  Authorization: string;
}

/**
 * Sign in the way the app does: ask for a code, read it back, verify it.
 *
 * Outside production the server returns the code it issued as `devCode`, which
 * is what lets a test sign in without an SMS gateway. A brand new number gets a
 * clinic, a location and a doctor membership as a side effect, which is the
 * sign-up flow.
 */
export const signIn = async (phone: string, name?: string): Promise<SignedIn> => {
  const send = await request(app).post('/api/v1/auth/otp/send').send({ phone }).expect(200);
  const code = send.body.data.devCode as string;
  if (!code) {
    throw new Error('the server did not return a devCode; is OTP_LOG_IN_DEV off?');
  }

  const verify = await request(app)
    .post('/api/v1/auth/otp/verify')
    .send({ phone, code, ...(name ? { name } : {}) })
    .expect(200);

  const session = verify.body.data;
  const membership = session.memberships[0];

  return {
    userId: session.user.id,
    phone,
    accessToken: session.tokens.access.token,
    refreshToken: session.tokens.refresh.token,
    practiceId: membership?.practiceId ?? '',
    locationId: membership?.locations[0]?.id ?? '',
  };
};

/** The headers every route except /auth and /me needs. */
export const headersFor = (actor: SignedIn, options: { location?: boolean | string } = {}): Headers => {
  const headers: Headers = {
    Authorization: `Bearer ${actor.accessToken}`,
    'X-Practice-Id': actor.practiceId,
  };
  if (options.location) {
    headers['X-Location-Id'] = typeof options.location === 'string' ? options.location : actor.locationId;
  }
  return headers;
};

/** A doctor with a clinic, plus a patient on today's list. */
export const aClinic = async (phone: string, name = 'Dr Ayesha') => {
  const doctor = await signIn(phone, name);
  const headers = headersFor(doctor, { location: true });

  const patient = await request(app)
    .post('/api/v1/patients')
    .set(headersFor(doctor))
    .send({ name: 'Test Patient', age: 40, sex: 'male' })
    .expect(201);

  return { doctor, headers, patientId: patient.body.data.id as string };
};

/** A PA added by the doctor, signed in and holding her own tokens. */
export const aPa = async (doctor: SignedIn, phone: string, locationIds?: string[]) => {
  await request(app)
    .post('/api/v1/members')
    .set(headersFor(doctor))
    .send({ phone, name: 'Sana', role: 'pa', locationIds: locationIds ?? [doctor.locationId] })
    .expect(201);

  const pa = await signIn(phone);
  return pa;
};

/** A draft prescription for a patient, owned by the doctor. */
export const aDraft = async (doctor: SignedIn, patientId: string, source = 'typed') => {
  const created = await request(app)
    .post('/api/v1/prescriptions')
    .set(headersFor(doctor, { location: true }))
    .send({ patientId, source })
    .expect(201);
  return created.body.data;
};

/** A plain sleep. Wrapped so the timer handle is not returned out of a promise executor. */
export const pause = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Poll until a predicate holds, the way the app polls for a transcription.
 * Dictation is processed in the background, so there is nothing to await.
 */
export const waitFor = async <T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 10_000, everyMs = 50 } = {},
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const value = await probe();
    if (done(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting: last value was ${JSON.stringify(value)}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await pause(everyMs);
  }
};

/** Base64 of a JSON op list, which the mock dictation drivers hand straight to the server. */
export const dictate = (ops: unknown[]): string => Buffer.from(JSON.stringify(ops), 'utf8').toString('base64');

/** Base64 of plain speech, which the mock extractor files as complaints. */
export const speak = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
