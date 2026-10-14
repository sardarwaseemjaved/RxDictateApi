import request from 'supertest';
import { Types } from 'mongoose';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, headersFor, pause, signIn, signUp, type SignedIn } from '../fixtures/clinic.fixture';
import { provider as smsProvider } from '../../src/core/sms';
import { Membership, Notification, Patient, Visit } from '../../src/models';
import { todayInKarachi } from '../../src/utils/time';

setupTestDB();

/** A signed-in user holding the `patient` role, which no route lets you create. */
const aPatientRole = async (doctor: SignedIn, phone: string): Promise<Record<string, string>> => {
  const user = await signIn(phone);
  await Membership.create({
    userId: new Types.ObjectId(user.userId),
    practiceId: new Types.ObjectId(doctor.practiceId),
    role: 'patient',
    locationIds: [new Types.ObjectId(doctor.locationId)],
    status: 'active',
    addedBy: new Types.ObjectId(doctor.userId),
    createdBy: new Types.ObjectId(doctor.userId),
  });
  return {
    Authorization: `Bearer ${user.accessToken}`,
    'X-Practice-Id': doctor.practiceId,
    'X-Location-Id': doctor.locationId,
  };
};

describe('The assistant flow', () => {
  describe("today's queue", () => {
    test('tokens start at 1 and count up per location per day', async () => {
      const { doctor } = await aClinic('+923007770001');
      const headers = headersFor(doctor, { location: true });

      const second = await request(app)
        .post('/api/v1/locations')
        .set(headersFor(doctor))
        .send({ name: 'Clifton branch' })
        .expect(201);
      const otherHeaders = headersFor(doctor, { location: second.body.data.id });

      const makePatient = async (name: string) =>
        (
          await request(app)
            .post('/api/v1/patients')
            .set(headersFor(doctor))
            .send({ name, age: 30, sex: 'male' })
            .expect(201)
        ).body.data.id as string;

      const [a, b, c] = await Promise.all([makePatient('A'), makePatient('B'), makePatient('C')]);

      const first = await request(app).post('/api/v1/visits').set(headers).send({ patientId: a }).expect(201);
      const next = await request(app).post('/api/v1/visits').set(headers).send({ patientId: b }).expect(201);
      expect(first.body.data.token).toBe(1);
      expect(next.body.data.token).toBe(2);

      // Another location keeps its own sequence.
      const elsewhere = await request(app).post('/api/v1/visits').set(otherHeaders).send({ patientId: c }).expect(201);
      expect(elsewhere.body.data.token).toBe(1);
    });

    test('a token is never reused, even after the visit is gone', async () => {
      const { doctor, patientId } = await aClinic('+923007770002');
      const headers = headersFor(doctor, { location: true });

      const first = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      expect(first.body.data.token).toBe(1);

      // The patient leaves and the row goes with them.
      await Visit.deleteOne({ _id: first.body.data.id });

      const other = await request(app)
        .post('/api/v1/patients')
        .set(headersFor(doctor))
        .send({ name: 'Second', age: 20, sex: 'female' })
        .expect(201);
      const second = await request(app)
        .post('/api/v1/visits')
        .set(headers)
        .send({ patientId: other.body.data.id })
        .expect(201);

      // 2, not 1. Whoever is holding slip number 1 has already heard it called.
      expect(second.body.data.token).toBe(2);
    });

    test('concurrent registrations never collide on a token', async () => {
      const { doctor } = await aClinic('+923007770003');
      const headers = headersFor(doctor, { location: true });

      const ids = await Promise.all(
        [1, 2, 3, 4, 5].map(async (n) => {
          const created = await request(app)
            .post('/api/v1/patients')
            .set(headersFor(doctor))
            .send({ name: `Patient ${n}`, age: 30, sex: 'male' })
            .expect(201);
          return created.body.data.id as string;
        }),
      );

      const visits = await Promise.all(
        ids.map((patientId) => request(app).post('/api/v1/visits').set(headers).send({ patientId })),
      );
      visits.forEach((response) => expect(response.status).toBe(201));

      const tokens = visits.map((response) => response.body.data.token as number);
      expect(new Set(tokens).size).toBe(5);
      expect([...tokens].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    });

    test('carries the reason, the status clock and whether vitals are done', async () => {
      const { doctor, patientId } = await aClinic('+923007770004');
      const headers = headersFor(doctor, { location: true });

      const created = await request(app)
        .post('/api/v1/visits')
        .set(headers)
        .send({ patientId, reason: 'Fever 3 days' })
        .expect(201);
      expect(created.body.data.reason).toBe('Fever 3 days');
      expect(created.body.data.vitalsRecordedAt).toBeNull();
      const firstStamp = created.body.data.statusChangedAt;

      await pause(20);
      const moved = await request(app)
        .patch(`/api/v1/visits/${created.body.data.id}`)
        .set(headers)
        .send({ status: 'with_doctor' })
        .expect(200);

      // The clock restarts, which is what "went in 6 min ago" counts from.
      expect(new Date(moved.body.data.statusChangedAt).getTime()).toBeGreaterThan(new Date(firstStamp).getTime());

      const list = await request(app).get('/api/v1/visits').set(headers).expect(200);
      expect(list.body.data[0]).toMatchObject({ token: 1, reason: 'Fever 3 days', status: 'with_doctor' });
    });

    test('the queue comes back in arrival order', async () => {
      const { doctor } = await aClinic('+923007770005');
      const headers = headersFor(doctor, { location: true });

      for (let n = 1; n <= 3; n += 1) {
        // eslint-disable-next-line no-await-in-loop
        const patient = await request(app)
          .post('/api/v1/patients')
          .set(headersFor(doctor))
          .send({ name: `Queue ${n}`, age: 30, sex: 'male' })
          .expect(201);
        // eslint-disable-next-line no-await-in-loop
        await request(app).post('/api/v1/visits').set(headers).send({ patientId: patient.body.data.id }).expect(201);
      }

      const list = await request(app).get('/api/v1/visits').set(headers).expect(200);
      expect(list.body.data.map((visit: { token: number }) => visit.token)).toEqual([1, 2, 3]);
    });
  });

  describe('registering a patient', () => {
    test('gets an MR number, sequential per practice', async () => {
      const { doctor } = await aClinic('+923007770010');
      const headers = headersFor(doctor);

      const second = await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Second', age: 44, sex: 'female' })
        .expect(201);

      // aClinic already registered one, so this is the second.
      expect(second.body.data.mrNo).toBe('MR-10002');

      const other = await aClinic('+923007770011');
      const theirs = await request(app).get(`/api/v1/patients/${other.patientId}`).set(headersFor(other.doctor)).expect(200);
      // Each clinic counts from its own beginning.
      expect(theirs.body.data.mrNo).toBe('MR-10001');
    });

    test('records allergies, and refuses a chart that says both', async () => {
      const { doctor } = await aClinic('+923007770012');
      const headers = headersFor(doctor);

      const withAllergies = await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Allergic', age: 30, sex: 'male', allergies: ['Penicillin', 'Sulfa'] })
        .expect(201);
      expect(withAllergies.body.data.allergies).toEqual(['Penicillin', 'Sulfa']);
      expect(withAllergies.body.data.noKnownAllergies).toBe(false);

      const asked = await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Asked', age: 30, sex: 'male', noKnownAllergies: true })
        .expect(201);
      expect(asked.body.data.noKnownAllergies).toBe(true);

      // Never asked is the default, and is not the same as "asked, none".
      const neverAsked = await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Unasked', age: 30, sex: 'male' })
        .expect(201);
      expect(neverAsked.body.data).toMatchObject({ allergies: [], noKnownAllergies: false });

      const contradiction = await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Both', age: 30, sex: 'male', allergies: ['Penicillin'], noKnownAllergies: true })
        .expect(400);
      expect(contradiction.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('the contradiction is caught across two requests, not just within one', async () => {
      const { doctor } = await aClinic('+923007770013');
      const headers = headersFor(doctor);

      const patient = await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Allergic', age: 30, sex: 'male', allergies: ['Penicillin'] })
        .expect(201);

      // The body alone looks fine; the record it would produce does not.
      const response = await request(app)
        .patch(`/api/v1/patients/${patient.body.data.id}`)
        .set(headers)
        .send({ noKnownAllergies: true })
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');

      const unchanged = await Patient.findById(patient.body.data.id);
      expect(unchanged?.noKnownAllergies).toBe(false);
    });

    test('search finds a patient by MR number, with or without the prefix', async () => {
      const { doctor } = await aClinic('+923007770014');
      const headers = headersFor(doctor);

      const patient = await request(app)
        .post('/api/v1/patients')
        .set(headers)
        .send({ name: 'Findable', phone: '+923211234567', age: 30, sex: 'male' })
        .expect(201);
      const { mrNo } = patient.body.data;

      const spellings = [mrNo, mrNo.toLowerCase(), mrNo.replace('MR-', ''), mrNo.replace('-', '')];
      for (let i = 0; i < spellings.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const found = await request(app).get('/api/v1/patients').query({ q: spellings[i] }).set(headers).expect(200);
        expect(found.body.data.map((p: { mrNo: string }) => p.mrNo)).toContain(mrNo);
      }

      // Phone search still works, and the app sends E.164 even when the user
      // typed 0300.
      const byPhone = await request(app).get('/api/v1/patients').query({ q: '+92321' }).set(headers).expect(200);
      expect(byPhone.body.data).toHaveLength(1);
    });
  });

  describe('vitals', () => {
    const aVisit = async (doctor: SignedIn, patientId: string) =>
      (
        await request(app)
          .post('/api/v1/visits')
          .set(headersFor(doctor, { location: true }))
          .send({ patientId })
          .expect(201)
      ).body.data.id as string;

    test('a PA can record them, and the queue shows they are done', async () => {
      const { doctor, patientId } = await aClinic('+923007770020');
      const pa = await aPa(doctor, '+923007770021');
      const paHeaders = {
        Authorization: `Bearer ${pa.accessToken}`,
        'X-Practice-Id': doctor.practiceId,
        'X-Location-Id': doctor.locationId,
      };
      const visitId = await aVisit(doctor, patientId);

      const recorded = await request(app)
        .put(`/api/v1/visits/${visitId}/vitals`)
        .set(paHeaders)
        .send({ bp: '120/80', pulse: 76, tempF: 98.4, weightKg: 70, spo2: 98, complaints: 'Fever since Monday' })
        .expect(200);

      expect(recorded.body.data).toMatchObject({
        bp: '120/80',
        pulse: 76,
        tempF: 98.4,
        weightKg: 70,
        spo2: 98,
        complaints: 'Fever since Monday',
        recordedBy: pa.userId,
      });

      const queue = await request(app)
        .get('/api/v1/visits')
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      expect(queue.body.data[0].vitalsRecordedAt).not.toBeNull();
    });

    test('a second save replaces the first rather than adding a second record', async () => {
      const { doctor, patientId } = await aClinic('+923007770022');
      const headers = headersFor(doctor, { location: true });
      const visitId = await aVisit(doctor, patientId);

      const first = await request(app).put(`/api/v1/visits/${visitId}/vitals`).set(headers).send({ pulse: 76 }).expect(200);
      const second = await request(app)
        .put(`/api/v1/visits/${visitId}/vitals`)
        .set(headers)
        .send({ pulse: 88, bp: '130/85' })
        .expect(200);

      // Same record, corrected.
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.pulse).toBe(88);

      const read = await request(app).get(`/api/v1/visits/${visitId}/vitals`).set(headers).expect(200);
      expect(read.body.data).toMatchObject({ pulse: 88, bp: '130/85' });
    });

    test('404 until there are any', async () => {
      const { doctor, patientId } = await aClinic('+923007770023');
      const headers = headersFor(doctor, { location: true });
      const visitId = await aVisit(doctor, patientId);

      const response = await request(app).get(`/api/v1/visits/${visitId}/vitals`).set(headers).expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    test('a record with nothing measured in it is refused', async () => {
      const { doctor, patientId } = await aClinic('+923007770024');
      const headers = headersFor(doctor, { location: true });
      const visitId = await aVisit(doctor, patientId);

      const empty = await request(app).put(`/api/v1/visits/${visitId}/vitals`).set(headers).send({}).expect(400);
      expect(empty.body.error.code).toBe('VALIDATION_ERROR');

      // Complaints alone are not a reading.
      await request(app)
        .put(`/api/v1/visits/${visitId}/vitals`)
        .set(headers)
        .send({ complaints: 'Feeling unwell' })
        .expect(400);

      const badBp = await request(app)
        .put(`/api/v1/visits/${visitId}/vitals`)
        .set(headers)
        .send({ bp: '120 over 80' })
        .expect(400);
      expect(badBp.body.error.details[0].field).toBe('body.bp');
    });

    test('out-of-range readings reach the doctor', async () => {
      const { doctor, patientId } = await aClinic('+923007770025');
      const pa = await aPa(doctor, '+923007770028');
      const paHeaders = {
        Authorization: `Bearer ${pa.accessToken}`,
        'X-Practice-Id': doctor.practiceId,
        'X-Location-Id': doctor.locationId,
      };
      const visitId = await aVisit(doctor, patientId);

      // The PA takes them, which is the whole point of the notification: the
      // doctor is told by somebody else. Nobody is told about their own work.
      await request(app)
        .put(`/api/v1/visits/${visitId}/vitals`)
        .set(paHeaders)
        .send({ bp: '160/100', pulse: 120, tempF: 102.1, spo2: 90 })
        .expect(200);

      await pause(150);
      const notification = await Notification.findOne({ type: 'vitals.recorded' });
      expect(notification).not.toBeNull();
      expect(notification!.body).toContain('systolic');
      expect(notification!.body).toContain('spo2');
    });

    test('a patient cannot record or read them', async () => {
      const { doctor, patientId } = await aClinic('+923007770026');
      const patientHeaders = await aPatientRole(doctor, '+923007770027');
      const visitId = await aVisit(doctor, patientId);

      const write = await request(app)
        .put(`/api/v1/visits/${visitId}/vitals`)
        .set(patientHeaders)
        .send({ pulse: 76 })
        .expect(403);
      expect(write.body.error.code).toBe('FORBIDDEN');

      await request(app).get(`/api/v1/visits/${visitId}/vitals`).set(patientHeaders).expect(403);
    });

    test('a visit from another practice is not reachable', async () => {
      const a = await aClinic('+923007770029');
      const b = await aClinic('+923007770039');
      const visitId = await aVisit(b.doctor, b.patientId);

      await request(app)
        .put(`/api/v1/visits/${visitId}/vitals`)
        .set(headersFor(a.doctor, { location: true }))
        .send({ pulse: 76 })
        .expect(404);
    });
  });

  describe('reports', () => {
    test('a PA can file one against a patient', async () => {
      const { doctor, patientId } = await aClinic('+923007770030');
      const pa = await aPa(doctor, '+923007770031');
      const paHeaders = { Authorization: `Bearer ${pa.accessToken}`, 'X-Practice-Id': doctor.practiceId };

      const created = await request(app)
        .post(`/api/v1/patients/${patientId}/reports`)
        .set(paHeaders)
        .send({
          type: 'lab',
          testName: 'CBC',
          testDate: '2026-10-01',
          pageKeys: [`${doctor.practiceId}/reports/pages/a.jpg`, `${doctor.practiceId}/reports/pages/b.jpg`],
        })
        .expect(201);

      expect(created.body.data).toMatchObject({
        type: 'lab',
        testName: 'CBC',
        testDate: '2026-10-01',
        pages: 2,
        uploadedBy: pa.userId,
        reviewedAt: null,
      });

      const list = await request(app).get(`/api/v1/patients/${patientId}/reports`).set(paHeaders).expect(200);
      expect(list.body.data).toHaveLength(1);

      const detail = await request(app).get(`/api/v1/reports/${created.body.data.id}`).set(paHeaders).expect(200);
      expect(detail.body.data.pageUrls).toHaveLength(2);
    });

    test('the upload ticket says so plainly when storage is not configured', async () => {
      const { doctor } = await aClinic('+923007770032');

      // The suite runs the local driver, which cannot sign an upload.
      const response = await request(app)
        .post('/api/v1/reports/uploads')
        .set(headersFor(doctor))
        .send({ contentType: 'image/jpeg', size: 1024 })
        .expect(503);
      expect(response.body.error.code).toBe('STORAGE_UNAVAILABLE');
      expect(response.body.error.message).toContain('STORAGE_DRIVER=s3');
    });

    test('refuses a file type or a size the contract does not allow', async () => {
      const { doctor } = await aClinic('+923007770033');
      const headers = headersFor(doctor);

      await request(app)
        .post('/api/v1/reports/uploads')
        .set(headers)
        .send({ contentType: 'application/zip', size: 1024 })
        .expect(400);

      await request(app)
        .post('/api/v1/reports/uploads')
        .set(headers)
        .send({ contentType: 'image/jpeg', size: 50 * 1024 * 1024 })
        .expect(400);
    });

    test('a page key issued to another clinic is refused', async () => {
      const a = await aClinic('+923007770034');
      const b = await aClinic('+923007770035');

      const response = await request(app)
        .post(`/api/v1/patients/${a.patientId}/reports`)
        .set(headersFor(a.doctor))
        .send({
          type: 'lab',
          testName: 'CBC',
          testDate: '2026-10-01',
          pageKeys: [`${b.doctor.practiceId}/reports/pages/stolen.jpg`],
        })
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('a patient cannot upload one', async () => {
      const { doctor, patientId } = await aClinic('+923007770036');
      const patientHeaders = await aPatientRole(doctor, '+923007770037');

      await request(app)
        .post(`/api/v1/patients/${patientId}/reports`)
        .set(patientHeaders)
        .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: ['x'] })
        .expect(403);
    });
  });

  describe('the schedule', () => {
    test('books, lists by day and refuses a slot twice', async () => {
      const { doctor, patientId } = await aClinic('+923007770040');
      const headers = headersFor(doctor, { location: true });

      const booked = await request(app)
        .post('/api/v1/appointments')
        .set(headers)
        .send({ patientId, at: '2026-11-02T10:00:00.000Z', kind: 'new_problem', note: 'Review' })
        .expect(201);
      expect(booked.body.data).toMatchObject({ kind: 'new_problem', status: 'booked', note: 'Review' });
      expect(booked.body.data.patient.id).toBe(patientId);

      const clash = await request(app)
        .post('/api/v1/appointments')
        .set(headers)
        .send({ patientId, at: '2026-11-02T10:00:00.000Z', kind: 'follow_up' })
        .expect(409);
      expect(clash.body.error.code).toBe('CONFLICT');

      const list = await request(app)
        .get('/api/v1/appointments')
        .query({ from: '2026-11-01', to: '2026-11-07' })
        .set(headers)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.meta.countsByDay).toEqual({ '2026-11-02': 1 });

      // Outside the window.
      const empty = await request(app)
        .get('/api/v1/appointments')
        .query({ from: '2026-12-01', to: '2026-12-07' })
        .set(headers)
        .expect(200);
      expect(empty.body.data).toHaveLength(0);
    });

    test('cancelling frees the slot', async () => {
      const { doctor, patientId } = await aClinic('+923007770041');
      const headers = headersFor(doctor, { location: true });

      const booked = await request(app)
        .post('/api/v1/appointments')
        .set(headers)
        .send({ patientId, at: '2026-11-03T09:30:00.000Z', kind: 'follow_up' })
        .expect(201);

      const cancelled = await request(app)
        .post(`/api/v1/appointments/${booked.body.data.id}/cancel`)
        .set(headers)
        .expect(200);
      expect(cancelled.body.data.status).toBe('cancelled');

      // The slot is bookable again, and the cancelled row stays on record.
      await request(app)
        .post('/api/v1/appointments')
        .set(headers)
        .send({ patientId, at: '2026-11-03T09:30:00.000Z', kind: 'follow_up' })
        .expect(201);

      const list = await request(app)
        .get('/api/v1/appointments')
        .query({ from: '2026-11-03', to: '2026-11-03' })
        .set(headers)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
    });

    test('from must not be after to', async () => {
      const { doctor } = await aClinic('+923007770042');
      await request(app)
        .get('/api/v1/appointments')
        .query({ from: '2026-11-09', to: '2026-11-01' })
        .set(headersFor(doctor, { location: true }))
        .expect(400);
    });
  });

  describe('follow-ups to book', () => {
    const anApprovedRxWithFollowUp = async (doctor: SignedIn, patientId: string, followUp: object) => {
      const headers = headersFor(doctor, { location: true });
      const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
        .set(headers)
        .send({
          ops: [
            { op: 'add', section: 'medicines', value: { name: 'Panadol' } },
            { op: 'update', section: 'followUp', value: followUp },
          ],
        })
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.body.data.id}/approve`).set(headers).expect(200);
      return draft.body.data.id as string;
    };

    test('lists what the doctor asked for, and booking takes it off the list', async () => {
      const { doctor, patientId } = await aClinic('+923007770050');
      const headers = headersFor(doctor, { location: true });

      const prescriptionId = await anApprovedRxWithFollowUp(doctor, patientId, {
        date: '2026-12-01',
        note: 'if no better',
      });

      const unbooked = await request(app).get('/api/v1/follow-ups').set(headers).expect(200);
      expect(unbooked.body.data).toHaveLength(1);
      expect(unbooked.body.data[0]).toMatchObject({
        prescriptionId,
        dueDate: '2026-12-01',
        note: 'if no better',
        isOverdue: false,
      });
      expect(unbooked.body.data[0].patient.id).toBe(patientId);

      await request(app)
        .post('/api/v1/appointments')
        .set(headers)
        .send({ patientId, at: '2026-12-01T10:00:00.000Z', kind: 'follow_up', prescriptionId })
        .expect(201);

      const after = await request(app).get('/api/v1/follow-ups').set(headers).expect(200);
      expect(after.body.data).toHaveLength(0);
    });

    test('counts inDays from the day the prescription was signed, and marks it overdue', async () => {
      const { doctor, patientId } = await aClinic('+923007770051');
      const headers = headersFor(doctor, { location: true });

      // Due in a day's time, so not overdue.
      await anApprovedRxWithFollowUp(doctor, patientId, { inDays: 1 });

      const list = await request(app).get('/api/v1/follow-ups').set(headers).expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].isOverdue).toBe(false);
      expect(list.body.data[0].dueDate > todayInKarachi()).toBe(true);
    });

    test('a prescription with no follow-up is not on the list', async () => {
      const { doctor, patientId } = await aClinic('+923007770052');
      const headers = headersFor(doctor, { location: true });

      const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
        .set(headers)
        .send({ ops: [{ op: 'add', section: 'medicines', value: { name: 'Panadol' } }] })
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.body.data.id}/approve`).set(headers).expect(200);

      const list = await request(app).get('/api/v1/follow-ups').set(headers).expect(200);
      expect(list.body.data).toHaveLength(0);
    });

    test('a draft prescription is not a follow-up to book', async () => {
      const { doctor, patientId } = await aClinic('+923007770053');
      const headers = headersFor(doctor, { location: true });

      const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
        .set(headers)
        .send({ ops: [{ op: 'update', section: 'followUp', value: { date: '2026-12-01' } }] })
        .expect(200);

      const list = await request(app).get('/api/v1/follow-ups').set(headers).expect(200);
      expect(list.body.data).toHaveLength(0);
    });
  });

  describe('the notification inbox', () => {
    test('lists newest first with an unread count, and marks them read', async () => {
      const { doctor } = await aClinic('+923007770060');
      const headers = headersFor(doctor);

      // Three things the doctor is told about.
      const pa = await aPa(doctor, '+923007770061');
      await request(app)
        .post('/api/v1/patients')
        .set({ Authorization: `Bearer ${pa.accessToken}`, 'X-Practice-Id': doctor.practiceId })
        .send({ name: 'Walk-in', age: 22, sex: 'female' })
        .expect(201);
      await pause(200);

      const inbox = await request(app).get('/api/v1/notifications').set(headers).expect(200);
      expect(inbox.body.data.length).toBeGreaterThan(0);
      expect(inbox.body.meta.unread).toBe(inbox.body.meta.total);

      const times = inbox.body.data.map((n: { createdAt: string }) => new Date(n.createdAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);

      const first = inbox.body.data[0];
      const marked = await request(app)
        .post('/api/v1/notifications/read')
        .set(headers)
        .send({ ids: [first.id] })
        .expect(200);
      expect(marked.body.data.read).toBe(1);
      expect(marked.body.data.unread).toBe(inbox.body.meta.unread - 1);

      const unreadOnly = await request(app)
        .get('/api/v1/notifications')
        .query({ unreadOnly: 'true' })
        .set(headers)
        .expect(200);
      expect(unreadOnly.body.data.map((n: { id: string }) => n.id)).not.toContain(first.id);
    });

    test('an inbox holds only its owner notifications', async () => {
      const { doctor } = await aClinic('+923007770062');
      const pa = await aPa(doctor, '+923007770063');
      const paHeaders = { Authorization: `Bearer ${pa.accessToken}`, 'X-Practice-Id': doctor.practiceId };
      await pause(200);

      // She was told she was added. The doctor who added her was not: nobody
      // is told about something they just did themselves.
      const paInbox = await request(app).get('/api/v1/notifications').set(paHeaders).expect(200);
      expect(paInbox.body.data.map((n: { type: string }) => n.type)).toEqual(['member.added']);
      const empty = await request(app).get('/api/v1/notifications').set(headersFor(doctor)).expect(200);
      expect(empty.body.data).toHaveLength(0);

      // Now she does something, which is what he hears about.
      await request(app)
        .post('/api/v1/patients')
        .set(paHeaders)
        .send({ name: 'Walk-in', age: 22, sex: 'female' })
        .expect(201);
      await pause(200);

      const doctorInbox = await request(app).get('/api/v1/notifications').set(headersFor(doctor)).expect(200);
      expect(doctorInbox.body.data.map((n: { type: string }) => n.type)).toEqual(['patient.added']);

      // And she cannot reach into his inbox to mark it read.
      const attempt = await request(app)
        .post('/api/v1/notifications/read')
        .set(paHeaders)
        .send({ ids: [doctorInbox.body.data[0].id] })
        .expect(200);
      expect(attempt.body.data.read).toBe(0);

      const still = await request(app).get('/api/v1/notifications').set(headersFor(doctor)).expect(200);
      expect(still.body.meta.unread).toBe(1);
    });
  });

  describe('telling the assistant she was added', () => {
    /**
     * The message goes through core/sms, so the test watches the provider
     * rather than a log line: that is the seam a real gateway will be dropped
     * into, and it is what should still be covered when one is.
     */
    const watchSms = () => jest.spyOn(smsProvider(), 'send').mockResolvedValue(undefined);

    test('names the doctor and the clinic, and says what to install', async () => {
      const doctor = await signUp('+923007770080', 'Ayesha Khan');
      await request(app).patch('/api/v1/practice').set(headersFor(doctor)).send({ name: 'Shifa Clinic' }).expect(200);

      const send = watchSms();
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923007770081', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);
      await pause(200);

      expect(send).toHaveBeenCalledTimes(1);
      const [to, body] = send.mock.calls[0];
      expect(to).toBe('+923007770081');
      expect(body).toBe('Dr. Ayesha Khan added you to Shifa Clinic. Install the clinic app and sign in with this number.');
      // Nothing about her role: that is the clinic's business, not the
      // mobile network's.
      expect(body).not.toContain('pa');
    });

    test('does not say Dr twice when the name already carries it', async () => {
      const doctor = await signUp('+923007770082', 'Dr Imran');
      const send = watchSms();

      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923007770083', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);
      await pause(200);

      expect(send.mock.calls[0][1]).toMatch(/^Dr Imran added you to /);
    });

    test('falls back cleanly when the doctor has no name on file', async () => {
      const doctor = await signUp('+923007770084');
      const send = watchSms();

      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923007770085', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);
      await pause(200);

      expect(send.mock.calls[0][1]).toMatch(/^You have been added to /);
    });

    test('is not sent again to a number that is already a member', async () => {
      const doctor = await signUp('+923007770086', 'Ayesha Khan');
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923007770087', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);
      await pause(200);

      const send = watchSms();
      const again = await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923007770087', role: 'pa', locationIds: [doctor.locationId] })
        .expect(409);
      expect(again.body.error.code).toBe('ALREADY_MEMBER');
      await pause(200);

      expect(send).not.toHaveBeenCalled();
    });

    test('a gateway that is down does not undo the membership', async () => {
      const doctor = await signUp('+923007770088', 'Ayesha Khan');
      jest.spyOn(smsProvider(), 'send').mockRejectedValue(new Error('gateway timeout'));

      const added = await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923007770089', role: 'pa', locationIds: [doctor.locationId] })
        .expect(201);
      await pause(200);

      expect(added.body.data.status).toBe('active');
      expect(await Membership.countDocuments({ practiceId: doctor.practiceId, status: 'active' })).toBe(2);
    });
  });

  describe('the practice speciality', () => {
    test('is settable and comes back on the practice', async () => {
      const { doctor } = await aClinic('+923007770070');
      const headers = headersFor(doctor);

      const updated = await request(app)
        .patch('/api/v1/practice')
        .set(headers)
        .send({ speciality: 'Consultant Physician' })
        .expect(200);
      expect(updated.body.data.speciality).toBe('Consultant Physician');

      const read = await request(app).get('/api/v1/practice').set(headers).expect(200);
      expect(read.body.data.speciality).toBe('Consultant Physician');
    });
  });
});
