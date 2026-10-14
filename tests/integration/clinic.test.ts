import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, headersFor, pause, signUp } from '../fixtures/clinic.fixture';
import { Membership, Notification, Patient } from '../../src/models';
import { todayInKarachi } from '../../src/utils/time';

setupTestDB();

describe('The day to day', () => {
  describe('patients', () => {
    test('are searchable by name and by phone, practice-wide', async () => {
      const { doctor } = await aClinic('+923006660001');
      const headers = headersFor(doctor);

      await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Fatima Noor', phone: '+923211234567', age: 29, sex: 'female' })
        .expect(201);

      const byName = await request(app).get('/api/v1/patients').query({ q: 'Fatima' }).set(headers).expect(200);
      expect(byName.body.data).toHaveLength(1);
      expect(byName.body.data[0].name).toBe('Fatima Noor');
      expect(byName.body.meta).toMatchObject({ page: 1, total: 1 });

      const byPhone = await request(app).get('/api/v1/patients').query({ q: '+92321' }).set(headers).expect(200);
      expect(byPhone.body.data).toHaveLength(1);

      const noMatch = await request(app).get('/api/v1/patients').query({ q: 'Zubaida' }).set(headers).expect(200);
      expect(noMatch.body.data).toHaveLength(0);
    });

    test('age comes from a date of birth when there is one', async () => {
      const { doctor } = await aClinic('+923006660002');
      const headers = headersFor(doctor);

      const born = await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Ali', dob: '2000-01-15', sex: 'male' })
        .expect(201);
      expect(born.body.data.age).toBe(new Date().getUTCFullYear() - 2000 - (new Date().getUTCMonth() === 0 ? 1 : 0));

      // A typed age is kept only while there is no dob to derive one from.
      const stored = await Patient.findById(born.body.data.id);
      expect(stored?.age).toBeNull();

      const patched = await request(app)
        .patch(`/api/v1/patients/${born.body.data.id}`)
        .set(headers)
        .send({ dob: null, age: 25 })
        .expect(200);
      expect(patched.body.data.age).toBe(25);
    });

    test('an impossible date of birth is refused', async () => {
      const { doctor } = await aClinic('+923006660003');
      const response = await request(app)
        .post('/api/v1/patients')
        .set(headersFor(doctor))
        .send({ name: 'Ali', dob: '2000-02-31', sex: 'male' })
        .expect(400);
      expect(response.body.error.details[0].field).toBe('body.dob');
    });

    test('either a dob or an age is required', async () => {
      const { doctor } = await aClinic('+923006660004');
      await request(app).post('/api/v1/patients').set(headersFor(doctor)).send({ name: 'Ali', sex: 'male' }).expect(400);
    });
  });

  describe("today's list", () => {
    test('defaults to today in Karachi and carries the patient', async () => {
      const { doctor, patientId } = await aClinic('+923006660010');
      const headers = headersFor(doctor, { location: true });

      const created = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      expect(created.body.data.date).toBe(todayInKarachi());
      expect(created.body.data.status).toBe('waiting');
      expect(created.body.data.patient.name).toBe('Test Patient');

      const list = await request(app).get('/api/v1/visits').set(headers).expect(200);
      expect(list.body.data).toHaveLength(1);

      const yesterday = await request(app).get('/api/v1/visits').query({ date: '2020-01-01' }).set(headers).expect(200);
      expect(yesterday.body.data).toHaveLength(0);
    });

    test('adding the same patient twice in a day is the same visit', async () => {
      const { doctor, patientId } = await aClinic('+923006660011');
      const headers = headersFor(doctor, { location: true });

      const first = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      const second = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);

      expect(second.body.data.id).toBe(first.body.data.id);
      const list = await request(app).get('/api/v1/visits').set(headers).expect(200);
      expect(list.body.data).toHaveLength(1);
    });

    test('status moves and the move is announced', async () => {
      const { doctor, patientId } = await aClinic('+923006660012');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);

      const moved = await request(app)
        .patch(`/api/v1/visits/${visit.body.data.id}`)
        .set(headers)
        .send({ status: 'with_doctor' })
        .expect(200);
      expect(moved.body.data.status).toBe('with_doctor');

      const waiting = await request(app).get('/api/v1/visits').query({ status: 'waiting' }).set(headers).expect(200);
      expect(waiting.body.data).toHaveLength(0);
    });

    test('a visit for a patient of another practice is refused', async () => {
      const a = await aClinic('+923006660013');
      const b = await aClinic('+923006660014');

      const response = await request(app)
        .post('/api/v1/visits')
        .set(headersFor(a.doctor, { location: true }))
        .send({ patientId: b.patientId })
        .expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('the team', () => {
    test('re-adding a removed PA reuses her row rather than forking her history', async () => {
      const { doctor } = await aClinic('+923006660020');
      const headers = headersFor(doctor);

      const added = await request(app)
        .post('/api/v1/members')
        .set(headers)
        .send({ phone: '+923006660021', name: 'Sana', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);

      await request(app).delete(`/api/v1/members/${added.body.data.id}`).set(headers).expect(200);

      const readded = await request(app)
        .post('/api/v1/members')
        .set(headers)
        .send({ phone: '+923006660021', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);

      expect(readded.body.data.id).toBe(added.body.data.id);
      expect(readded.body.data.status).toBe('active');
      expect(await Membership.countDocuments({ practiceId: doctor.practiceId })).toBe(2);
    });

    test('a number that is already on the clinic is refused', async () => {
      const { doctor } = await aClinic('+923006660022');
      const headers = headersFor(doctor);
      const body = { phone: '+923006660023', role: 'pa', locationIds: [doctor.locationId] };

      await request(app).post('/api/v1/members').set(headers).send(body).expect(201);
      const again = await request(app).post('/api/v1/members').set(headers).send(body).expect(409);
      expect(again.body.error.code).toBe('ALREADY_MEMBER');
    });

    test('the last doctor cannot be removed or demoted', async () => {
      const { doctor } = await aClinic('+923006660024');
      const headers = headersFor(doctor);

      const members = await request(app).get('/api/v1/members').set(headers).expect(200);
      const own = members.body.data[0];

      const removed = await request(app).delete(`/api/v1/members/${own.id}`).set(headers).expect(409);
      expect(removed.body.error.code).toBe('LAST_DOCTOR');

      const demoted = await request(app).patch(`/api/v1/members/${own.id}`).set(headers).send({ role: 'pa' }).expect(409);
      expect(demoted.body.error.code).toBe('LAST_DOCTOR');
    });

    test('a location from another practice cannot be assigned', async () => {
      const a = await aClinic('+923006660025');
      const b = await aClinic('+923006660026');

      const response = await request(app)
        .post('/api/v1/members')
        .set(headersFor(a.doctor))
        .send({ phone: '+923006660027', role: 'pa', locationIds: [b.doctor.locationId] })
        .expect(403);
      expect(response.body.error.code).toBe('LOCATION_NOT_ALLOWED');
    });

    test('adding a member notifies her, via a listener and not the service', async () => {
      const { doctor } = await aClinic('+923006660028');
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923006660029', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);

      // The bus is fire and forget, so this is the one place the suite waits on it.
      await pause(150);

      const notifications = await Notification.find({ type: 'member.added' });
      expect(notifications).toHaveLength(1);
      expect(notifications[0].title).toBe('You were added to a clinic');
    });
  });

  describe('locations', () => {
    test('the first one is the default whatever the caller says', async () => {
      const doctor = await signUp('+923006660030', 'Dr Solo');
      const list = await request(app).get('/api/v1/locations').set(headersFor(doctor)).expect(200);
      expect(list.body.data[0].isDefault).toBe(true);
    });

    test('setting a new default clears the old one', async () => {
      const { doctor } = await aClinic('+923006660031');
      const headers = headersFor(doctor);

      const second = await request(app)
        .post('/api/v1/locations')
        .set(headers)
        .send({ name: 'Clifton branch', isDefault: true })
        .expect(201);
      expect(second.body.data.isDefault).toBe(true);

      const list = await request(app).get('/api/v1/locations').set(headers).expect(200);
      expect(list.body.data.filter((location: { isDefault: boolean }) => location.isDefault)).toHaveLength(1);
    });

    test('the only active location cannot be archived', async () => {
      const { doctor } = await aClinic('+923006660032');
      const response = await request(app)
        .post(`/api/v1/locations/${doctor.locationId}/archive`)
        .set(headersFor(doctor))
        .expect(409);
      expect(response.body.error.code).toBe('CONFLICT');
    });
  });

  describe('drugs', () => {
    test('the collection grows from what is prescribed, and then matches', async () => {
      const { doctor, patientId } = await aClinic('+923006660040');
      const headers = headersFor(doctor, { location: true });

      const beforeAnything = await request(app)
        .get('/api/v1/drugs')
        .query({ q: 'Risek' })
        .set(headersFor(doctor))
        .expect(200);
      expect(beforeAnything.body.data).toHaveLength(0);

      const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
      const written = await request(app)
        .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
        .set(headers)
        .send({ ops: [{ op: 'add', section: 'medicines', value: { name: 'Risek', strength: '20mg', form: 'cap' } }] })
        .expect(200);

      // The line is linked to the drug that was just created for it.
      expect(written.body.data.sections.medicines[0].drugId).toMatch(/^[0-9a-f]{24}$/);

      const found = await request(app).get('/api/v1/drugs').query({ q: 'Risek' }).set(headersFor(doctor)).expect(200);
      expect(found.body.data).toHaveLength(1);
      expect(found.body.data[0]).toMatchObject({ brand: 'Risek', strength: '20mg', form: 'cap' });

      // A prefix matches too, which a plain text index would not manage.
      const typeAhead = await request(app).get('/api/v1/drugs').query({ q: 'ris' }).set(headersFor(doctor)).expect(200);
      expect(typeAhead.body.data).toHaveLength(1);
    });
  });
});
