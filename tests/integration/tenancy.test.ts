import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, headersFor, signIn } from '../fixtures/clinic.fixture';
import { Location, Patient } from '../../src/models';

setupTestDB();

describe('Tenancy', () => {
  /**
   * The rule the whole data model exists to make true. If this test ever fails,
   * one clinic is reading another clinic's patient records.
   */
  describe('practice isolation', () => {
    test('practice A cannot read practice B patients, by search or by id', async () => {
      const a = await aClinic('+923001110001', 'Dr A');
      const b = await aClinic('+923001110002', 'Dr B');

      await request(app)
        .post('/api/v1/patients')
        .set(headersFor(b.doctor))
        .send({ name: 'Bilal Confidential', age: 31, sex: 'male' })
        .expect(201);

      // Both patients exist, in two practices.
      expect(await Patient.countDocuments({})).toBe(3);

      const search = await request(app).get('/api/v1/patients').query({ q: 'Bilal' }).set(headersFor(a.doctor)).expect(200);
      expect(search.body.data).toHaveLength(0);

      const listAll = await request(app).get('/api/v1/patients').set(headersFor(a.doctor)).expect(200);
      expect(listAll.body.data).toHaveLength(1);
      expect(listAll.body.data[0].id).toBe(a.patientId);

      const byId = await request(app).get(`/api/v1/patients/${b.patientId}`).set(headersFor(a.doctor)).expect(404);
      expect(byId.body.error.code).toBe('NOT_FOUND');
    });

    test('practice A cannot write to practice B patients', async () => {
      const a = await aClinic('+923001110003', 'Dr A');
      const b = await aClinic('+923001110004', 'Dr B');

      const patch = await request(app)
        .patch(`/api/v1/patients/${b.patientId}`)
        .set(headersFor(a.doctor))
        .send({ name: 'Renamed by the wrong clinic' })
        .expect(404);
      expect(patch.body.error.code).toBe('NOT_FOUND');

      const unchanged = await Patient.findById(b.patientId);
      expect(unchanged?.name).toBe('Test Patient');
    });

    test('a practice id the caller is not a member of is refused', async () => {
      const a = await aClinic('+923001110005', 'Dr A');
      const b = await aClinic('+923001110006', 'Dr B');

      const response = await request(app)
        .get('/api/v1/patients')
        .set({ Authorization: `Bearer ${a.doctor.accessToken}`, 'X-Practice-Id': b.doctor.practiceId })
        .expect(403);
      expect(response.body.error.code).toBe('NOT_MEMBER');
    });

    test('a location of another practice is refused', async () => {
      const a = await aClinic('+923001110007', 'Dr A');
      const b = await aClinic('+923001110008', 'Dr B');

      const response = await request(app)
        .get('/api/v1/visits')
        .set(headersFor(a.doctor, { location: b.doctor.locationId }))
        .expect(403);
      expect(response.body.error.code).toBe('LOCATION_NOT_ALLOWED');
    });
  });

  describe('headers', () => {
    test('a route needs X-Practice-Id', async () => {
      const doctor = await signIn('+923001110009', 'Dr A');
      const response = await request(app)
        .get('/api/v1/patients')
        .set({ Authorization: `Bearer ${doctor.accessToken}` })
        .expect(400);
      expect(response.body.error.code).toBe('PRACTICE_REQUIRED');
    });

    test('a location-scoped route needs X-Location-Id', async () => {
      const { doctor } = await aClinic('+923001110010');
      const response = await request(app).get('/api/v1/visits').set(headersFor(doctor)).expect(400);
      expect(response.body.error.code).toBe('LOCATION_REQUIRED');
    });

    test('an archived location is refused', async () => {
      const { doctor } = await aClinic('+923001110011');
      const second = await request(app)
        .post('/api/v1/locations')
        .set(headersFor(doctor))
        .send({ name: 'Second clinic' })
        .expect(201);

      await request(app).post(`/api/v1/locations/${doctor.locationId}/archive`).set(headersFor(doctor)).expect(200);

      const response = await request(app)
        .get('/api/v1/visits')
        .set(headersFor(doctor, { location: doctor.locationId }))
        .expect(409);
      expect(response.body.error.code).toBe('LOCATION_ARCHIVED');

      // The archived row is still there, because prescriptions point at it.
      expect(await Location.countDocuments({ practiceId: doctor.practiceId })).toBe(2);
      expect((await Location.findById(second.body.data.id))?.isDefault).toBe(true);
    });

    test('no token at all is a 401', async () => {
      const response = await request(app).get('/api/v1/patients').expect(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('a PA is held to her own locations', () => {
    test('she may use the location she was given and not the other one', async () => {
      const { doctor } = await aClinic('+923001110012');
      const other = await request(app)
        .post('/api/v1/locations')
        .set(headersFor(doctor))
        .send({ name: 'Clifton branch' })
        .expect(201);

      const pa = await aPa(doctor, '+923001110013', [doctor.locationId]);

      await request(app)
        .get('/api/v1/visits')
        .set({ ...headersFor(pa), 'X-Practice-Id': doctor.practiceId, 'X-Location-Id': doctor.locationId })
        .expect(200);

      const refused = await request(app)
        .get('/api/v1/visits')
        .set({
          Authorization: `Bearer ${pa.accessToken}`,
          'X-Practice-Id': doctor.practiceId,
          'X-Location-Id': other.body.data.id,
        })
        .expect(403);
      expect(refused.body.error.code).toBe('LOCATION_NOT_ALLOWED');
    });

    test('the doctor may use any location of his own practice', async () => {
      const { doctor } = await aClinic('+923001110014');
      const other = await request(app)
        .post('/api/v1/locations')
        .set(headersFor(doctor))
        .send({ name: 'Clifton branch' })
        .expect(201);

      await request(app)
        .get('/api/v1/visits')
        .set(headersFor(doctor, { location: other.body.data.id }))
        .expect(200);
    });

    test('she cannot write or approve a prescription, and cannot dictate', async () => {
      const { doctor, patientId } = await aClinic('+923001110015');
      const pa = await aPa(doctor, '+923001110016');
      const paHeaders = {
        Authorization: `Bearer ${pa.accessToken}`,
        'X-Practice-Id': doctor.practiceId,
        'X-Location-Id': doctor.locationId,
      };

      const create = await request(app).post('/api/v1/prescriptions').set(paHeaders).send({ patientId }).expect(403);
      expect(create.body.error.code).toBe('FORBIDDEN');

      await request(app).get('/api/v1/prescriptions').set(paHeaders).expect(200);

      const dictation = await request(app)
        .post('/api/v1/prescriptions/000000000000000000000000/voice/segments')
        .set(paHeaders)
        .send({ seq: 1, durationMs: 1000, contentType: 'audio/m4a', audioBase64: 'AA==' })
        .expect(403);
      expect(dictation.body.error.code).toBe('FORBIDDEN');
    });

    test('she cannot add or remove members, or touch locations and settings', async () => {
      const { doctor } = await aClinic('+923001110017');
      const pa = await aPa(doctor, '+923001110018');
      const paHeaders = { Authorization: `Bearer ${pa.accessToken}`, 'X-Practice-Id': doctor.practiceId };

      await request(app)
        .post('/api/v1/members')
        .set(paHeaders)
        .send({ phone: '+923009999999', locationIds: [doctor.locationId] })
        .expect(403);
      await request(app).get('/api/v1/members').set(paHeaders).expect(403);
      await request(app).post('/api/v1/locations').set(paHeaders).send({ name: 'Nope' }).expect(403);
      await request(app).patch('/api/v1/practice').set(paHeaders).send({ name: 'Nope' }).expect(403);
    });

    test('removing her ends her session immediately', async () => {
      const { doctor } = await aClinic('+923001110019');
      const pa = await aPa(doctor, '+923001110020');
      const paHeaders = { Authorization: `Bearer ${pa.accessToken}`, 'X-Practice-Id': doctor.practiceId };

      await request(app).get('/api/v1/patients').set(paHeaders).expect(200);

      const members = await request(app).get('/api/v1/members').set(headersFor(doctor)).expect(200);
      const membership = members.body.data.find((member: { role: string }) => member.role === 'pa');

      await request(app).delete(`/api/v1/members/${membership.id}`).set(headersFor(doctor)).expect(200);

      // The access token is still signed and unexpired, but membership is read
      // on every request, so it stops working now rather than in half an hour.
      const after = await request(app).get('/api/v1/patients').set(paHeaders).expect(403);
      expect(after.body.error.code).toBe('NOT_MEMBER');
    });
  });
});
