import request from 'supertest';
import { Types } from 'mongoose';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, headersFor, type SignedIn } from '../fixtures/clinic.fixture';
import { Lab } from '../../src/models';

setupTestDB();

interface Item {
  kind: 'visit' | 'prescription' | 'lab' | 'report';
  id: string;
  at: string;
  [key: string]: unknown;
}

const historyOf = async (doctor: SignedIn, patientId: string, query: Record<string, string | number> = {}) =>
  request(app).get(`/api/v1/patients/${patientId}/history`).query(query).set(headersFor(doctor));

/** A prescription with a diagnosis, a medicine and the labs given, approved. */
const anApprovedRx = async (doctor: SignedIn, patientId: string, labs: string[], location = doctor.locationId) => {
  const headers = headersFor(doctor, { location });
  const draft = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
  const id = draft.body.data.id as string;
  await request(app)
    .patch(`/api/v1/prescriptions/${id}`)
    .set(headers)
    .send({
      ops: [
        { op: 'add', section: 'diagnosis', value: { text: 'Hypertension' } },
        { op: 'add', section: 'medicines', value: { name: 'Amlodipine', strength: '5mg' } },
        ...labs.map((text) => ({ op: 'add', section: 'labs', value: { text } })),
      ],
    })
    .expect(200);
  await request(app).post(`/api/v1/prescriptions/${id}/approve`).set(headers).expect(200);
  return id;
};

const aReport = async (doctor: SignedIn, patientId: string) => {
  const report = await request(app)
    .post(`/api/v1/patients/${patientId}/reports`)
    .set(headersFor(doctor))
    .send({
      type: 'imaging',
      testName: 'Chest X-ray',
      testDate: '2026-09-30',
      pageKeys: [`${doctor.practiceId}/reports/pages/x.jpg`],
    })
    .expect(201);
  return report.body.data.id as string;
};

describe('A patient history', () => {
  test('is one timeline, newest first, of visits, prescriptions, labs and reports', async () => {
    const { doctor, patientId } = await aClinic('+923023330001');
    const headers = headersFor(doctor, { location: true });

    const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId, reason: 'BP check' }).expect(201);
    await request(app)
      .put(`/api/v1/visits/${visit.body.data.id}/vitals`)
      .set(headers)
      .send({ bp: '150/95', pulse: 80 })
      .expect(200);
    const prescriptionId = await anApprovedRx(doctor, patientId, ['CBC', 'Lipid profile']);
    const reportId = await aReport(doctor, patientId);

    const response = await historyOf(doctor, patientId).expect(200);
    const items = response.body.data as Item[];

    expect(items.map((item) => item.kind)).toEqual(['report', 'lab', 'lab', 'prescription', 'visit']);
    expect(response.body.meta).toEqual({ page: 1, limit: 20, total: 5, totalPages: 1 });

    const times = items.map((item) => new Date(item.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    expect(items[0]).toMatchObject({ id: reportId, type: 'imaging', testName: 'Chest X-ray', pages: 1, reviewedAt: null });

    const labs = items.filter((item) => item.kind === 'lab');
    expect(labs.map((lab) => lab.name).sort()).toEqual(['CBC', 'Lipid profile']);
    labs.forEach((lab) => expect(lab).toMatchObject({ prescriptionId, result: '', hasFile: false }));

    expect(items[3]).toMatchObject({
      id: prescriptionId,
      status: 'approved',
      version: 1,
      diagnosis: ['Hypertension'],
      medicineNames: ['Amlodipine'],
      hasPdf: false,
    });
    expect(items[3].number).toMatch(/^RX-/);

    expect(items[4]).toMatchObject({ id: visit.body.data.id, reason: 'BP check', status: 'done', token: 1 });
    expect(items[4].vitals).toMatchObject({ bp: '150/95', pulse: 80 });
  });

  test('a visit with no vitals says so', async () => {
    const { doctor, patientId } = await aClinic('+923023330002');
    await request(app)
      .post('/api/v1/visits')
      .set(headersFor(doctor, { location: true }))
      .send({ patientId })
      .expect(201);

    const response = await historyOf(doctor, patientId).expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].vitals).toBeNull();
  });

  test('narrows to one kind', async () => {
    const { doctor, patientId } = await aClinic('+923023330003');
    await anApprovedRx(doctor, patientId, ['CBC']);
    await aReport(doctor, patientId);

    const labs = await historyOf(doctor, patientId, { kind: 'lab' }).expect(200);
    expect(labs.body.data.map((item: Item) => item.kind)).toEqual(['lab']);
    expect(labs.body.meta.total).toBe(1);

    const reports = await historyOf(doctor, patientId, { kind: 'report' }).expect(200);
    expect(reports.body.data.map((item: Item) => item.kind)).toEqual(['report']);

    await historyOf(doctor, patientId, { kind: 'vitals' }).expect(400);
  });

  test('pages through the merged timeline without repeating or skipping', async () => {
    const { doctor, patientId } = await aClinic('+923023330004');
    await anApprovedRx(doctor, patientId, ['CBC', 'LFT', 'RFT']);
    await aReport(doctor, patientId);
    await aReport(doctor, patientId);

    // Starting the prescription put the patient on today's list, so: a visit,
    // the prescription, three labs and two reports.
    const all = await historyOf(doctor, patientId, { limit: 100 }).expect(200);
    expect(all.body.meta.total).toBe(8);

    const pages: Item[] = [];
    for (let page = 1; page <= 4; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const response = await historyOf(doctor, patientId, { page, limit: 2 }).expect(200);
      expect(response.body.meta).toMatchObject({ page, limit: 2, total: 8, totalPages: 4 });
      pages.push(...response.body.data);
    }

    expect(pages.map((item) => item.id)).toEqual(all.body.data.map((item: Item) => item.id));
  });

  test('is practice-wide: a visit at another location is part of it', async () => {
    const { doctor, patientId } = await aClinic('+923023330005');
    const branch = await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'Branch' }).expect(201);

    await request(app)
      .post('/api/v1/visits')
      .set(headersFor(doctor, { location: true }))
      .send({ patientId })
      .expect(201);
    await request(app)
      .post('/api/v1/visits')
      .set(headersFor(doctor, { location: branch.body.data.id }))
      .send({ patientId, date: '2026-09-01' })
      .expect(201);

    const response = await historyOf(doctor, patientId).expect(200);
    expect(response.body.data.map((item: Item) => item.locationId).sort()).toEqual(
      [doctor.locationId, branch.body.data.id].sort(),
    );
  });

  test('leaves out a cancelled draft and keeps an open one', async () => {
    const { doctor, patientId } = await aClinic('+923023330006');
    const headers = headersFor(doctor, { location: true });

    const cancelled = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
    await request(app).post(`/api/v1/prescriptions/${cancelled.body.data.id}/cancel`).set(headers).expect(200);
    const open = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);

    const response = await historyOf(doctor, patientId, { kind: 'prescription' }).expect(200);
    expect(response.body.data.map((item: Item) => item.id)).toEqual([open.body.data.id]);
    expect(response.body.data[0]).toMatchObject({ status: 'draft', number: null });
  });

  test('a revision replaces the labs that have no result, and keeps one that has', async () => {
    const { doctor, patientId } = await aClinic('+923023330007');
    const headers = headersFor(doctor, { location: true });
    const v1 = await anApprovedRx(doctor, patientId, ['CBC', 'Urine R/E']);

    // A result came back for one of them before the revision.
    await Lab.updateOne({ prescriptionId: new Types.ObjectId(v1), name: 'Urine R/E' }, { $set: { result: 'NAD' } });

    const revision = await request(app).post(`/api/v1/prescriptions/${v1}/revise`).set(headers).send({}).expect(201);
    const v2 = revision.body.data.id as string;
    const lft = { op: 'add', section: 'labs', value: { text: 'LFT' } };
    await request(app)
      .patch(`/api/v1/prescriptions/${v2}`)
      .set(headers)
      .send({ ops: [lft] })
      .expect(200);
    await request(app).post(`/api/v1/prescriptions/${v2}/approve`).set(headers).expect(200);

    const response = await historyOf(doctor, patientId, { kind: 'lab' }).expect(200);
    const labs = response.body.data as Item[];
    const named = (name: string) => labs.filter((lab) => lab.name === name);

    // v2 ordered CBC, Urine R/E and LFT again; v1's unresulted CBC is gone.
    expect(named('CBC')).toHaveLength(1);
    expect(named('CBC')[0].prescriptionId).toBe(v2);
    expect(named('LFT')[0].prescriptionId).toBe(v2);
    // v1's Urine R/E carries a result, so it stays, beside v2's new order.
    expect(
      named('Urine R/E')
        .map((lab) => lab.prescriptionId)
        .sort(),
    ).toEqual([v1, v2].sort());
    expect(named('Urine R/E').find((lab) => lab.prescriptionId === v1)?.result).toBe('NAD');
  });

  test("is the doctor's alone", async () => {
    const { doctor, patientId } = await aClinic('+923023330008');
    const pa = await aPa(doctor, '+923023330009');

    const response = await request(app)
      .get(`/api/v1/patients/${patientId}/history`)
      .set({ Authorization: `Bearer ${pa.accessToken}`, 'X-Practice-Id': doctor.practiceId })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  test("another clinic's patient is not found, and nothing of theirs leaks in", async () => {
    const a = await aClinic('+923023330010');
    const b = await aClinic('+923023330011');
    await anApprovedRx(b.doctor, b.patientId, ['CBC']);

    const response = await historyOf(a.doctor, b.patientId).expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');

    const own = await historyOf(a.doctor, a.patientId).expect(200);
    expect(own.body.data).toHaveLength(0);
  });
});
