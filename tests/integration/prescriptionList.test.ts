import request from 'supertest';
import { Types } from 'mongoose';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, aPa, headersFor, type SignedIn } from '../fixtures/clinic.fixture';
import { Patient, Prescription } from '../../src/models';

setupTestDB();

interface Row {
  id: string;
  patientId: string;
  patient: { id: string; name: string; age: number | null; sex: string; mrNo: string } | null;
}

const aPatient = async (doctor: SignedIn, body: Record<string, unknown>) => {
  const created = await request(app).post('/api/v1/patients').set(headersFor(doctor)).send(body).expect(201);
  return created.body.data as { id: string; mrNo: string };
};

const list = (doctor: SignedIn, query: Record<string, string> = {}) =>
  request(app)
    .get('/api/v1/prescriptions')
    .query(query)
    .set(headersFor(doctor, { location: true }));

describe('The prescriptions list', () => {
  test('carries who each one is for, so a list needs no request per row', async () => {
    const { doctor, patientId } = await aClinic('+923025550001');
    const other = await aPatient(doctor, { name: 'Fatima Noor', age: 29, sex: 'female' });
    await aDraft(doctor, patientId);
    await aDraft(doctor, other.id);

    const response = await list(doctor).expect(200);
    const rows = response.body.data as Row[];

    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row.patient?.id).toBe(row.patientId));
    expect(rows.find((row) => row.patientId === other.id)?.patient).toEqual({
      id: other.id,
      name: 'Fatima Noor',
      age: 29,
      sex: 'female',
      mrNo: other.mrNo,
    });
    // Only these five: the list is not the place for a patient's chart.
    expect(Object.keys(rows[0].patient!).sort()).toEqual(['age', 'id', 'mrNo', 'name', 'sex']);
  });

  test('the single read is unchanged and has no patient on it', async () => {
    const { doctor, patientId } = await aClinic('+923025550002');
    const draft = await aDraft(doctor, patientId);

    const one = await request(app)
      .get(`/api/v1/prescriptions/${draft.id}`)
      .set(headersFor(doctor, { location: true }))
      .expect(200);
    expect(one.body.data).not.toHaveProperty('patient');
  });

  test('a removed patient reads as null, not as an error', async () => {
    const { doctor, patientId } = await aClinic('+923025550003');
    await aDraft(doctor, patientId);
    await Patient.updateOne({ _id: patientId }, { $set: { deletedAt: new Date() } });

    const response = await list(doctor).expect(200);
    expect(response.body.data[0].patient).toBeNull();
  });

  test('narrows to a range of days, inclusive, in Karachi time', async () => {
    const { doctor, patientId } = await aClinic('+923025550004');
    const other = await aPatient(doctor, { name: 'Ali', age: 40, sex: 'male' });
    const third = await aPatient(doctor, { name: 'Zara', age: 22, sex: 'female' });
    const early = await aDraft(doctor, patientId);
    const middle = await aDraft(doctor, other.id);
    const late = await aDraft(doctor, third.id);

    // Straight to the collection: mongoose keeps createdAt immutable, which is
    // right everywhere except in a test that needs to move a row in time.
    const startedAt = (id: string, at: string) =>
      Prescription.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { createdAt: new Date(at) } });

    // 23:30 Karachi on the 1st is 18:30 UTC; 00:30 Karachi on the 3rd is 19:30 UTC on the 2nd.
    await startedAt(early.id, '2026-10-01T18:30:00.000Z');
    await startedAt(middle.id, '2026-10-02T10:00:00.000Z');
    await startedAt(late.id, '2026-10-02T19:30:00.000Z');

    const day1 = await list(doctor, { from: '2026-10-01', to: '2026-10-01' }).expect(200);
    expect(day1.body.data.map((row: Row) => row.id)).toEqual([early.id]);

    const day2 = await list(doctor, { from: '2026-10-02', to: '2026-10-02' }).expect(200);
    expect(day2.body.data.map((row: Row) => row.id)).toEqual([middle.id]);

    const onwards = await list(doctor, { from: '2026-10-02' }).expect(200);
    expect(onwards.body.data.map((row: Row) => row.id)).toEqual([late.id, middle.id]);

    const upTo = await list(doctor, { to: '2026-10-02' }).expect(200);
    expect(upTo.body.data.map((row: Row) => row.id)).toEqual([middle.id, early.id]);

    const backwards = await list(doctor, { from: '2026-10-03', to: '2026-10-01' }).expect(400);
    expect(backwards.body.error.code).toBe('VALIDATION_ERROR');
    await list(doctor, { from: '2026-10-32' }).expect(400);
  });

  test('finds by patient name, phone or MR number', async () => {
    const { doctor, patientId } = await aClinic('+923025550005');
    const fatima = await aPatient(doctor, { name: 'Fatima Noor', phone: '+923211234567', age: 29, sex: 'female' });
    const fatimaRx = await aDraft(doctor, fatima.id);
    await aDraft(doctor, patientId);

    const byName = await list(doctor, { q: 'Fatima' }).expect(200);
    expect(byName.body.data.map((row: Row) => row.id)).toEqual([fatimaRx.id]);

    const byPhone = await list(doctor, { q: '+92321' }).expect(200);
    expect(byPhone.body.data.map((row: Row) => row.id)).toEqual([fatimaRx.id]);

    const byMr = await list(doctor, { q: fatima.mrNo.toLowerCase() }).expect(200);
    expect(byMr.body.data.map((row: Row) => row.id)).toEqual([fatimaRx.id]);

    const nobody = await list(doctor, { q: 'Zubaida' }).expect(200);
    expect(nobody.body.data).toHaveLength(0);
    expect(nobody.body.meta.total).toBe(0);

    // With patientId as well, both have to hold.
    const both = await list(doctor, { q: 'Fatima', patientId }).expect(200);
    expect(both.body.data).toHaveLength(0);
  });

  test("q never reaches another clinic's patients", async () => {
    const a = await aClinic('+923025550006');
    const b = await aClinic('+923025550007');
    const theirs = await aPatient(b.doctor, { name: 'Fatima Noor', age: 29, sex: 'female' });
    await aDraft(b.doctor, theirs.id);

    const response = await list(a.doctor, { q: 'Fatima' }).expect(200);
    expect(response.body.data).toHaveLength(0);
  });

  test('a PA sees the list, with names, at their own location only', async () => {
    const { doctor, patientId } = await aClinic('+923025550008');
    const branch = await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'Branch' }).expect(201);
    const pa = await aPa(doctor, '+923025550009');
    await aDraft(doctor, patientId);

    const own = await request(app)
      .get('/api/v1/prescriptions')
      .set({
        Authorization: `Bearer ${pa.accessToken}`,
        'X-Practice-Id': doctor.practiceId,
        'X-Location-Id': doctor.locationId,
      })
      .expect(200);
    expect(own.body.data).toHaveLength(1);
    expect(own.body.data[0].patient.name).toBe('Test Patient');

    const elsewhere = await request(app)
      .get('/api/v1/prescriptions')
      .set({
        Authorization: `Bearer ${pa.accessToken}`,
        'X-Practice-Id': doctor.practiceId,
        'X-Location-Id': branch.body.data.id,
      })
      .expect(403);
    expect(elsewhere.body.error.code).toBe('LOCATION_NOT_ALLOWED');
  });
});
