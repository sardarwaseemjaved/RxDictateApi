import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, headersFor, type SignedIn } from '../fixtures/clinic.fixture';

setupTestDB();

type Method = 'get' | 'post' | 'patch' | 'delete';

interface Route {
  method: Method;
  path: string;
  /** Location-scoped routes need X-Location-Id as well. */
  location?: boolean;
  body?: Record<string, unknown>;
}

/**
 * Every route in the product, called the way the app would call it.
 *
 * The point is not that each one does the right thing - the suites either side
 * of this one cover that - but that each one is mounted, spelled the way it
 * always will be, and reachable by somebody who is allowed to ask. A 404 here
 * means the app would be linking at nothing.
 */
const BUILT: Route[] = [
  { method: 'get', path: '/api/v1/me' },
  { method: 'patch', path: '/api/v1/me', body: { name: 'Dr Who' } },

  { method: 'get', path: '/api/v1/practice' },
  { method: 'patch', path: '/api/v1/practice', body: { name: 'Shifa' } },

  { method: 'get', path: '/api/v1/locations' },
  { method: 'post', path: '/api/v1/locations', body: { name: 'Second branch' } },

  { method: 'get', path: '/api/v1/members' },

  { method: 'get', path: '/api/v1/patients' },
  { method: 'post', path: '/api/v1/patients', body: { name: 'Walk-in', age: 22, sex: 'female' } },

  { method: 'get', path: '/api/v1/visits', location: true },

  { method: 'get', path: '/api/v1/prescriptions', location: true },

  { method: 'get', path: '/api/v1/drugs?q=panadol' },
];

/** Mounted now, answering 501, so nothing is renamed when they go live. */
const NOT_IMPLEMENTED: Route[] = [
  { method: 'get', path: '/api/v1/notifications' },
  { method: 'post', path: '/api/v1/notifications/read', body: { ids: ['6540000000000000000000aa'] } },
  { method: 'post', path: '/api/v1/devices', body: { pushToken: 'abc', platform: 'ios' } },
  { method: 'get', path: '/api/v1/templates' },
  { method: 'post', path: '/api/v1/templates' },
  { method: 'get', path: '/api/v1/appointments', location: true },
  { method: 'post', path: '/api/v1/appointments', location: true },
  { method: 'get', path: '/api/v1/portal/anything' },
];

describe('Every route in the product responds', () => {
  let doctor: SignedIn;
  let patientId: string;

  beforeEach(async () => {
    const clinic = await aClinic('+923005550001', 'Dr Route');
    doctor = clinic.doctor;
    patientId = clinic.patientId;
  });

  test('the built ones answer with real data', async () => {
    for (let i = 0; i < BUILT.length; i += 1) {
      const route = BUILT[i];
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app)
        [route.method](route.path)
        .set(headersFor(doctor, { location: route.location }))
        .send(route.body ?? {});

      expect({ route: `${route.method.toUpperCase()} ${route.path}`, status: response.status }).toEqual({
        route: `${route.method.toUpperCase()} ${route.path}`,
        status: expect.any(Number),
      });
      expect(response.status).toBeLessThan(400);
      expect(response.body).toHaveProperty('data');
    }
  });

  test('the ones that are not built yet answer 501, not 404', async () => {
    for (let i = 0; i < NOT_IMPLEMENTED.length; i += 1) {
      const route = NOT_IMPLEMENTED[i];
      // eslint-disable-next-line no-await-in-loop
      const response = await request(app)
        [route.method](route.path)
        .set(headersFor(doctor, { location: route.location }))
        .send(route.body ?? {});

      expect({ route: `${route.method.toUpperCase()} ${route.path}`, status: response.status }).toEqual({
        route: `${route.method.toUpperCase()} ${route.path}`,
        status: 501,
      });
      expect(response.body.error.code).toBe('NOT_IMPLEMENTED');
    }
  });

  test('the per-record routes respond, including the ones that are not built', async () => {
    const headers = headersFor(doctor, { location: true });

    const location = await request(app)
      .post('/api/v1/locations')
      .set(headersFor(doctor))
      .send({ name: 'Branch' })
      .expect(201);
    await request(app)
      .patch(`/api/v1/locations/${location.body.data.id}`)
      .set(headersFor(doctor))
      .send({ phone: '042-1' })
      .expect(200);
    await request(app).post(`/api/v1/locations/${location.body.data.id}/archive`).set(headersFor(doctor)).expect(200);

    const member = await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923005550002', role: 'pa', locationIds: [doctor.locationId] })
      .expect(201);
    await request(app)
      .patch(`/api/v1/members/${member.body.data.id}`)
      .set(headersFor(doctor))
      .send({ name: 'Sana' })
      .expect(200);
    await request(app).delete(`/api/v1/members/${member.body.data.id}`).set(headersFor(doctor)).expect(200);

    await request(app).get(`/api/v1/patients/${patientId}`).set(headersFor(doctor)).expect(200);
    await request(app)
      .patch(`/api/v1/patients/${patientId}`)
      .set(headersFor(doctor))
      .send({ phone: '+923005550003' })
      .expect(200);

    const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
    await request(app)
      .patch(`/api/v1/visits/${visit.body.data.id}`)
      .set(headers)
      .send({ status: 'with_doctor' })
      .expect(200);

    const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
    const id = draft.body.data.id as string;
    await request(app).get(`/api/v1/prescriptions/${id}`).set(headers).expect(200);
    await request(app)
      .patch(`/api/v1/prescriptions/${id}`)
      .set(headers)
      .send({ ops: [{ op: 'add', section: 'advice', value: { text: 'Rest' } }] })
      .expect(200);
    await request(app).get(`/api/v1/prescriptions/${id}/voice`).set(headers).expect(200);
    await request(app).post(`/api/v1/prescriptions/${id}/approve`).set(headers).expect(200);
    await request(app).get(`/api/v1/prescriptions/${id}/pdf`).set(headers).expect(200);
    await request(app).post(`/api/v1/prescriptions/${id}/revise`).set(headers).send({}).expect(201);

    // 501, but mounted and spelled as they will stay.
    const history = await request(app).get(`/api/v1/patients/${patientId}/history`).set(headersFor(doctor)).expect(501);
    expect(history.body.error.code).toBe('NOT_IMPLEMENTED');
    await request(app).post(`/api/v1/patients/${patientId}/reports`).set(headersFor(doctor)).expect(501);
    await request(app).get(`/api/v1/reports/${patientId}`).set(headersFor(doctor)).expect(501);
    await request(app).post(`/api/v1/prescriptions/from-template/${patientId}`).set(headers).expect(501);
  });

  test('an unknown path is a 404 in the standard envelope', async () => {
    const response = await request(app).get('/api/v1/nope').set(headersFor(doctor)).expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toContain('/api/v1/nope');
  });

  test('the old boilerplate paths are gone', async () => {
    await request(app).post('/v1/auth/login').send({ email: 'a@b.c', password: 'password1' }).expect(404);
    await request(app).get('/v1/users').expect(404);
    await request(app).post('/v1/app-auth/send-passcode').send({}).expect(404);
  });

  test('every response carries the request id back', async () => {
    const response = await request(app).get('/api/v1/me').set(headersFor(doctor)).expect(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await request(app)
      .get('/api/v1/me')
      .set({ ...headersFor(doctor), 'X-Request-Id': 'app-trace-42' })
      .expect(200);
    expect(echoed.headers['x-request-id']).toBe('app-trace-42');
  });
});
