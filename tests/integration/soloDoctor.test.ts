import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, headersFor, type SignedIn } from '../fixtures/clinic.fixture';
import { Patient, Visit } from '../../src/models';
import { karachiDay, todayInKarachi } from '../../src/utils/time';

setupTestDB();

const addMedicine = { ops: [{ op: 'add', section: 'medicines', value: { name: 'Panadol' } }] };

const aPatient = async (doctor: SignedIn, name: string, extra: Record<string, unknown> = {}) => {
  const created = await request(app)
    .post('/api/v1/patients')
    .set(headersFor(doctor))
    .send({ name, age: 40, sex: 'male', ...extra })
    .expect(201);
  return created.body.data;
};

/**
 * A doctor with no assistant never touches the queue. Writing a prescription
 * is what says the consultation is happening, so the server keeps the visit in
 * step - these used to be two extra round trips the app made by hand, which
 * meant they could half happen.
 */
describe('A doctor working alone', () => {
  describe('the visit follows the prescription', () => {
    test('starting one puts the patient on today list and takes them in', async () => {
      const { doctor, patientId } = await aClinic('+923009990001');
      const headers = headersFor(doctor, { location: true });

      // Nobody is on the list yet.
      expect((await request(app).get('/api/v1/visits').set(headers).expect(200)).body.data).toHaveLength(0);

      const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);

      const queue = await request(app).get('/api/v1/visits').set(headers).expect(200);
      expect(queue.body.data).toHaveLength(1);
      expect(queue.body.data[0]).toMatchObject({ id: draft.body.data.visitId, token: 1, status: 'with_doctor' });
    });

    test('a patient already waiting is taken in rather than listed twice', async () => {
      const { doctor, patientId } = await aClinic('+923009990002');
      const headers = headersFor(doctor, { location: true });

      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId, reason: 'Fever' }).expect(201);
      expect(visit.body.data.status).toBe('waiting');

      const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);

      expect(draft.body.data.visitId).toBe(visit.body.data.id);
      const queue = await request(app).get('/api/v1/visits').set(headers).expect(200);
      expect(queue.body.data).toHaveLength(1);
      expect(queue.body.data[0].status).toBe('with_doctor');
      // The reason the PA typed is not lost.
      expect(queue.body.data[0].reason).toBe('Fever');
    });

    test('a visit named explicitly is still taken in', async () => {
      const { doctor, patientId } = await aClinic('+923009990003');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);

      await request(app)
        .post('/api/v1/prescriptions')
        .set(headers)
        .send({ patientId, visitId: visit.body.data.id })
        .expect(201);

      expect((await Visit.findById(visit.body.data.id))?.status).toBe('with_doctor');
    });

    test('approving closes the visit', async () => {
      const { doctor, patientId } = await aClinic('+923009990004');
      const headers = headersFor(doctor, { location: true });

      const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
      await request(app).patch(`/api/v1/prescriptions/${draft.body.data.id}`).set(headers).send(addMedicine).expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.body.data.id}/approve`).set(headers).expect(200);

      const visit = await Visit.findById(draft.body.data.visitId);
      expect(visit?.status).toBe('done');

      // And it is off the waiting list, where the queue screen looks.
      const waiting = await request(app).get('/api/v1/visits').query({ status: 'waiting' }).set(headers).expect(200);
      expect(waiting.body.data).toHaveLength(0);
    });

    test('a patient seen earlier today keeps their visit and their token', async () => {
      const { doctor, patientId } = await aClinic('+923009990005');
      const headers = headersFor(doctor, { location: true });

      const first = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
      await request(app).patch(`/api/v1/prescriptions/${first.body.data.id}`).set(headers).send(addMedicine).expect(200);
      await request(app).post(`/api/v1/prescriptions/${first.body.data.id}/approve`).set(headers).expect(200);

      // They come back the same afternoon.
      const second = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);

      expect(second.body.data.id).not.toBe(first.body.data.id);
      // Same consultation of the day: one visit, one token, taken in again.
      expect(second.body.data.visitId).toBe(first.body.data.visitId);
      expect(await Visit.countDocuments({ patientId })).toBe(1);

      const queue = await request(app).get('/api/v1/visits').set(headers).expect(200);
      expect(queue.body.data).toHaveLength(1);
      expect(queue.body.data[0]).toMatchObject({ token: 1, status: 'with_doctor' });
    });

    test('a patient of another practice is refused before anything is listed', async () => {
      const a = await aClinic('+923009990006');
      const b = await aClinic('+923009990007');

      await request(app)
        .post('/api/v1/prescriptions')
        .set(headersFor(a.doctor, { location: true }))
        .send({ patientId: b.patientId })
        .expect(404);

      expect(await Visit.countDocuments({})).toBe(0);
    });
  });

  describe('the patients list', () => {
    test('carries known conditions', async () => {
      const { doctor } = await aClinic('+923009990010');
      const headers = headersFor(doctor);

      const patient = await aPatient(doctor, 'Diabetic', { conditions: ['Diabetes', 'Hypertension'] });
      expect(patient.conditions).toEqual(['Diabetes', 'Hypertension']);

      const updated = await request(app)
        .patch(`/api/v1/patients/${patient.id}`)
        .set(headers)
        .send({ conditions: ['Diabetes'] })
        .expect(200);
      expect(updated.body.data.conditions).toEqual(['Diabetes']);

      const fresh = await aPatient(doctor, 'Nobody');
      expect(fresh.conditions).toEqual([]);
    });

    test('shows when each patient was last in', async () => {
      const { doctor, patientId } = await aClinic('+923009990011');
      const headers = headersFor(doctor, { location: true });

      const before = await request(app).get(`/api/v1/patients/${patientId}`).set(headersFor(doctor)).expect(200);
      expect(before.body.data.lastVisitDate).toBeNull();

      await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);

      const after = await request(app).get(`/api/v1/patients/${patientId}`).set(headersFor(doctor)).expect(200);
      expect(after.body.data.lastVisitDate).toBe(todayInKarachi());
    });

    test('a backdated visit does not drag the last-seen date backwards', async () => {
      const { doctor, patientId } = await aClinic('+923009990012');
      const headers = headersFor(doctor, { location: true });

      await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      await request(app).post('/api/v1/visits').set(headers).send({ patientId, date: '2020-01-01' }).expect(201);

      expect((await Patient.findById(patientId))?.lastVisitDate).toBe(todayInKarachi());
    });

    test('sorts by last visit, newest first, with the never-seen at the bottom', async () => {
      const { doctor } = await aClinic('+923009990013');
      const headers = headersFor(doctor, { location: true });

      const old = await aPatient(doctor, 'Seen long ago');
      const recent = await aPatient(doctor, 'Seen today');
      const never = await aPatient(doctor, 'Never seen');

      await request(app).post('/api/v1/visits').set(headers).send({ patientId: old.id, date: '2026-09-22' }).expect(201);
      await request(app).post('/api/v1/visits').set(headers).send({ patientId: recent.id }).expect(201);

      const byVisit = await request(app)
        .get('/api/v1/patients')
        .query({ sort: 'lastVisit' })
        .set(headersFor(doctor))
        .expect(200);
      const order = byVisit.body.data.map((p: { name: string }) => p.name);

      expect(order[0]).toBe('Seen today');
      expect(order[1]).toBe('Seen long ago');
      expect(order[order.length - 1]).toBe('Never seen');
      expect(never.lastVisitDate).toBeNull();

      // Name order is still the default, so nothing that already asks is changed.
      const byName = await request(app).get('/api/v1/patients').set(headersFor(doctor)).expect(200);
      const names = byName.body.data.map((p: { name: string }) => p.name);
      expect(names).toEqual([...names].sort());
    });
  });

  describe('the list chips', () => {
    /**
     * A patient seen weeks ago and asked back on a date that has since gone
     * by.
     *
     * The consultation is backdated afterwards, because approving a
     * prescription puts the patient on today's list - and a follow-up asked
     * for on the same day it is already overdue is not a case that happens.
     * This is the one that does: seen in September, asked back in early
     * October, and not seen since.
     */
    const withOverdueFollowUp = async (doctor: SignedIn, name: string) => {
      const headers = headersFor(doctor, { location: true });
      const patient = await aPatient(doctor, name);

      const draft = await request(app)
        .post('/api/v1/prescriptions')
        .set(headers)
        .send({ patientId: patient.id })
        .expect(201);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
        .set(headers)
        .send({
          ops: [
            { op: 'add', section: 'medicines', value: { name: 'Panadol' } },
            { op: 'update', section: 'followUp', value: { date: '2026-10-01' } },
          ],
        })
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.body.data.id}/approve`).set(headers).expect(200);

      // That consultation was in September.
      await Visit.updateMany({ patientId: patient.id }, { $set: { date: '2026-09-22' } });
      await Patient.updateOne({ _id: patient.id }, { $set: { lastVisitDate: '2026-09-22' } });

      return patient;
    };

    test('follow-up due lists the patient who was asked back and did not come', async () => {
      const { doctor } = await aClinic('+923009990020');
      const overdue = await withOverdueFollowUp(doctor, 'Did not return');

      const list = await request(app)
        .get('/api/v1/patients')
        .query({ followUpDue: 'true' })
        .set(headersFor(doctor))
        .expect(200);

      expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([overdue.id]);
      expect(list.body.meta.counts.followUpDue).toBe(1);
      // The All chip keeps the practice total while a filter is on.
      expect(list.body.meta.counts.all).toBeGreaterThan(1);
    });

    test('a follow-up still in the future is not due', async () => {
      const { doctor } = await aClinic('+923009990021');
      const headers = headersFor(doctor, { location: true });
      const patient = await aPatient(doctor, 'Coming back later');

      const draft = await request(app)
        .post('/api/v1/prescriptions')
        .set(headers)
        .send({ patientId: patient.id })
        .expect(201);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
        .set(headers)
        .send({
          ops: [
            { op: 'add', section: 'medicines', value: { name: 'Panadol' } },
            { op: 'update', section: 'followUp', value: { date: '2099-01-01' } },
          ],
        })
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.body.data.id}/approve`).set(headers).expect(200);

      const list = await request(app)
        .get('/api/v1/patients')
        .query({ followUpDue: 'true' })
        .set(headersFor(doctor))
        .expect(200);
      expect(list.body.data).toHaveLength(0);
      expect(list.body.meta.counts.followUpDue).toBe(0);
    });

    test('coming in after the due date takes them off the list', async () => {
      const { doctor } = await aClinic('+923009990022');
      const headers = headersFor(doctor, { location: true });
      const overdue = await withOverdueFollowUp(doctor, 'Came back');

      const before = await request(app)
        .get('/api/v1/patients')
        .query({ followUpDue: 'true' })
        .set(headersFor(doctor))
        .expect(200);
      expect(before.body.data).toHaveLength(1);

      // They walk in today.
      await request(app).post('/api/v1/visits').set(headers).send({ patientId: overdue.id }).expect(201);
      expect((await Patient.findById(overdue.id))?.lastVisitDate).toBe(karachiDay());

      const after = await request(app)
        .get('/api/v1/patients')
        .query({ followUpDue: 'true' })
        .set(headersFor(doctor))
        .expect(200);
      expect(after.body.data).toHaveLength(0);
    });

    test('new reports lists the patient with something unreviewed', async () => {
      const { doctor, patientId } = await aClinic('+923009990023');
      const headers = headersFor(doctor);
      await aPatient(doctor, 'Nothing to read');

      await request(app)
        .post(`/api/v1/patients/${patientId}/reports`)
        .set(headers)
        .send({
          type: 'lab',
          testName: 'CBC',
          testDate: '2026-10-01',
          pageKeys: [`${doctor.practiceId}/reports/pages/a.jpg`],
        })
        .expect(201);

      const list = await request(app).get('/api/v1/patients').query({ newReports: 'true' }).set(headers).expect(200);
      expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([patientId]);
      expect(list.body.meta.counts.newReports).toBe(1);
    });

    test('both chips together means both, not either', async () => {
      const { doctor } = await aClinic('+923009990024');
      const headers = headersFor(doctor);

      const overdueOnly = await withOverdueFollowUp(doctor, 'Overdue only');
      const both = await withOverdueFollowUp(doctor, 'Overdue and unread');
      await request(app)
        .post(`/api/v1/patients/${both.id}/reports`)
        .set(headers)
        .send({
          type: 'lab',
          testName: 'CBC',
          testDate: '2026-10-01',
          pageKeys: [`${doctor.practiceId}/reports/pages/b.jpg`],
        })
        .expect(201);

      const list = await request(app)
        .get('/api/v1/patients')
        .query({ followUpDue: 'true', newReports: 'true' })
        .set(headers)
        .expect(200);

      expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([both.id]);
      expect(list.body.data.map((p: { id: string }) => p.id)).not.toContain(overdueOnly.id);
    });

    test('the counts are there even with no filter on', async () => {
      const { doctor } = await aClinic('+923009990025');
      await withOverdueFollowUp(doctor, 'Did not return');

      const list = await request(app).get('/api/v1/patients').set(headersFor(doctor)).expect(200);
      expect(list.body.meta.counts).toEqual({ all: 2, followUpDue: 1, newReports: 0 });
    });

    test('a chip never reaches into another practice', async () => {
      const a = await aClinic('+923009990026');
      const b = await aClinic('+923009990027');
      await withOverdueFollowUp(b.doctor, 'Theirs');

      const list = await request(app)
        .get('/api/v1/patients')
        .query({ followUpDue: 'true' })
        .set(headersFor(a.doctor))
        .expect(200);
      expect(list.body.data).toHaveLength(0);
      expect(list.body.meta.counts.followUpDue).toBe(0);
    });
  });
});
