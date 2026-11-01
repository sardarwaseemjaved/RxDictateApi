import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, headersFor, type SignedIn } from '../fixtures/clinic.fixture';
import { Patient, PatientIntroduction, Visit } from '../../src/models';
import { backfillPatientLocations } from '../../src/services/patient.service';

setupTestDB();

const BUSHRA_PHONE = '+923331234567';

/**
 * One clinic with two locations, A (the default) and B, and an assistant at
 * each, one at both, and a patient registered at each. The fixture's own
 * patient was registered by the doctor without saying where, so it is at A.
 */
const aTwoLocationClinic = async (prefix: string) => {
  const { doctor, patientId: fixturePatient } = await aClinic(`${prefix}01`, 'Dr Two');
  const branch = await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'B' }).expect(201);
  const a = doctor.locationId;
  const b = branch.body.data.id as string;

  const atA = await aPa(doctor, `${prefix}02`, [a]);
  const atB = await aPa(doctor, `${prefix}03`, [b]);
  const atBoth = await aPa(doctor, `${prefix}04`, [a, b]);

  const register = async (actor: SignedIn, name: string, location?: string, phone?: string) =>
    (
      await request(app)
        .post('/api/v1/patients')
        .set(headersFor(actor, { location }))
        .send({ name, age: 30, sex: 'female', ...(phone ? { phone } : {}) })
        .expect(201)
    ).body.data.id as string;

  const aOnly = await register(doctor, 'Asma at A', a);
  const bOnly = await register(doctor, 'Bushra at B', b, BUSHRA_PHONE);

  return { doctor, a, b, atA, atB, atBoth, register, fixturePatient, aOnly, bOnly };
};

/** Headers for a member, at one of their locations. */
const at = (actor: SignedIn, location: string) => headersFor(actor, { location });

const namesFor = async (headers: Record<string, string>, query: Record<string, string> = {}) => {
  const response = await request(app).get('/api/v1/patients').query(query).set(headers).expect(200);
  return { names: response.body.data.map((p: { name: string }) => p.name).sort(), meta: response.body.meta };
};

const linksOf = async (id: string): Promise<string[]> => (await Patient.findById(id))!.locationIds.map(String).sort();

const aReport = async (doctor: SignedIn, patientId: string) =>
  (
    await request(app)
      .post(`/api/v1/patients/${patientId}/reports`)
      .set(headersFor(doctor))
      .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: [`${doctor.practiceId}/reports/pages/a.jpg`] })
      .expect(201)
  ).body.data.id as string;

describe('An assistant sees only the patients of their own locations', () => {
  describe('an assistant at A', () => {
    test("search, the list, its total and the All count cover A's patients only", async () => {
      const { a, atA, doctor } = await aTwoLocationClinic('+92300501');

      const list = await namesFor(at(atA, a));
      expect(list.names).toEqual(['Asma at A', 'Test Patient']);
      expect(list.meta.total).toBe(2);
      expect(list.meta.counts.all).toBe(2);

      expect((await namesFor(at(atA, a), { q: 'Bushra' })).names).toEqual([]);
      expect((await namesFor(at(atA, a), { q: 'Asma' })).names).toEqual(['Asma at A']);

      // The doctor's search is the whole clinic, as it always was.
      const all = await namesFor(headersFor(doctor));
      expect(all.names).toEqual(['Asma at A', 'Bushra at B', 'Test Patient']);
      expect(all.meta.counts.all).toBe(3);
    });

    test('a patient only seen at B is NOT_FOUND everywhere, as if they did not exist', async () => {
      const { doctor, a, b, atA, aOnly, bOnly } = await aTwoLocationClinic('+92300502');
      const headers = at(atA, a);
      const reportId = await aReport(doctor, bOnly);
      const notFound = (response: request.Response) => {
        expect(response.status).toBe(404);
        expect(response.body.error.code).toBe('NOT_FOUND');
      };

      await request(app).get(`/api/v1/patients/${aOnly}`).set(headers).expect(200);

      notFound(await request(app).get(`/api/v1/patients/${bOnly}`).set(headers));
      notFound(await request(app).patch(`/api/v1/patients/${bOnly}`).set(headers).send({ name: 'Renamed' }));
      notFound(await request(app).get(`/api/v1/patients/${bOnly}/reports`).set(headers));
      notFound(
        await request(app)
          .post(`/api/v1/patients/${bOnly}/reports`)
          .set(headers)
          .send({
            type: 'lab',
            testName: 'CBC',
            testDate: '2026-10-01',
            pageKeys: [`${doctor.practiceId}/reports/pages/b.jpg`],
          }),
      );
      notFound(await request(app).get(`/api/v1/reports/${reportId}`).set(headers));
      notFound(await request(app).post('/api/v1/visits').set(headers).send({ patientId: bOnly }));
      notFound(
        await request(app)
          .post('/api/v1/appointments')
          .set(headers)
          .send({ patientId: bOnly, at: '2026-11-02T10:00:00.000Z', kind: 'new_problem' }),
      );
      notFound(await request(app).get('/api/v1/prescriptions').query({ patientId: bOnly }).set(headers));

      // Nothing was written on the way to any of those answers.
      expect((await Patient.findById(bOnly))!.name).toBe('Bushra at B');
      expect(await linksOf(bOnly)).toEqual([b]);
      expect(await Visit.countDocuments({ patientId: bOnly })).toBe(0);
    });

    test('the new-reports and follow-up-due counts leave out the patients of other locations', async () => {
      const { doctor, a, b, atA, atB, aOnly, bOnly } = await aTwoLocationClinic('+92300503');
      await aReport(doctor, aOnly);
      await aReport(doctor, bOnly);

      // Bushra was asked back on the 1st, at B, and has not come.
      const atBHeaders = headersFor(doctor, { location: b });
      const draft = await request(app).post('/api/v1/prescriptions').set(atBHeaders).send({ patientId: bOnly }).expect(201);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
        .set(atBHeaders)
        .send({
          ops: [
            { op: 'add', section: 'medicines', value: { name: 'Panadol' } },
            { op: 'update', section: 'followUp', value: { date: '2026-10-01' } },
          ],
        })
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.body.data.id}/approve`).set(atBHeaders).expect(200);
      await Visit.updateMany({ patientId: bOnly }, { $set: { date: '2026-09-22' } });
      await Patient.updateOne({ _id: bOnly }, { $set: { lastVisitDate: '2026-09-22' } });

      const forA = await namesFor(at(atA, a), { newReports: 'true' });
      expect(forA.names).toEqual(['Asma at A']);
      expect(forA.meta.counts).toEqual({ all: 2, followUpDue: 0, newReports: 1 });
      expect((await namesFor(at(atA, a), { followUpDue: 'true' })).names).toEqual([]);

      const forB = await namesFor(at(atB, b), { followUpDue: 'true' });
      expect(forB.names).toEqual(['Bushra at B']);
      expect(forB.meta.counts).toEqual({ all: 1, followUpDue: 1, newReports: 1 });

      expect((await namesFor(headersFor(doctor))).meta.counts).toEqual({ all: 3, followUpDue: 1, newReports: 2 });
    });
  });

  test('an assistant at A and B sees both', async () => {
    const { a, atBoth, bOnly } = await aTwoLocationClinic('+92300504');

    const list = await namesFor(at(atBoth, a));
    expect(list.names).toEqual(['Asma at A', 'Bushra at B', 'Test Patient']);
    expect(list.meta.counts.all).toBe(3);
    await request(app).get(`/api/v1/patients/${bOnly}`).set(at(atBoth, a)).expect(200);
  });

  describe('links', () => {
    test('registering links the patient to where they were registered', async () => {
      const { doctor, a, b, atA, atBoth, register, fixturePatient, aOnly, bOnly } = await aTwoLocationClinic('+92300505');

      expect(await linksOf(aOnly)).toEqual([a]);
      expect(await linksOf(bOnly)).toEqual([b]);
      // No header: the doctor's goes to the default location...
      expect(await linksOf(fixturePatient)).toEqual([a]);
      expect(await linksOf(await register(doctor, 'Doctor, no header'))).toEqual([a]);
      // ...and an assistant's to every location they work at, so they can find it.
      expect(await linksOf(await register(atA, 'Assistant, no header'))).toEqual([a]);
      expect(await linksOf(await register(atBoth, 'Both, no header'))).toEqual([a, b].sort());
      // A location the assistant does not work at is ignored, not trusted.
      expect(await linksOf(await register(atA, 'Assistant, wrong header', b))).toEqual([a]);
    });

    test('a visit or an appointment links the location it is at', async () => {
      const { doctor, a, b, aOnly, register } = await aTwoLocationClinic('+92300506');

      await request(app)
        .post('/api/v1/visits')
        .set(headersFor(doctor, { location: b }))
        .send({ patientId: aOnly })
        .expect(201);
      expect(await linksOf(aOnly)).toEqual([a, b].sort());

      const booked = await register(doctor, 'Booked at B', a);
      await request(app)
        .post('/api/v1/appointments')
        .set(headersFor(doctor, { location: b }))
        .send({ patientId: booked, at: '2026-11-02T10:00:00.000Z', kind: 'new_problem' })
        .expect(201);
      expect(await linksOf(booked)).toEqual([a, b].sort());
    });

    test("a patient who comes to a second location is visible to that location's assistant once added there", async () => {
      const { doctor, b, atB, aOnly } = await aTwoLocationClinic('+92300507');

      await request(app).get(`/api/v1/patients/${aOnly}`).set(at(atB, b)).expect(404);

      await request(app)
        .post('/api/v1/visits')
        .set(headersFor(doctor, { location: b }))
        .send({ patientId: aOnly })
        .expect(201);

      await request(app).get(`/api/v1/patients/${aOnly}`).set(at(atB, b)).expect(200);
      expect((await namesFor(at(atB, b))).names).toEqual(['Asma at A', 'Bushra at B']);
    });
  });

  describe('a whole phone number', () => {
    test('finds a patient registered elsewhere, and adding them to the list links them', async () => {
      const { a, b, atA, bOnly } = await aTwoLocationClinic('+92300508');
      const headers = at(atA, a);

      // The start of the number is still only their own patients.
      expect((await namesFor(headers, { q: '+92333' })).names).toEqual([]);

      expect((await namesFor(headers, { q: BUSHRA_PHONE })).names).toEqual(['Bushra at B']);

      // Found, so they can be opened and put on the list here, rather than
      // registered a second time.
      await request(app).get(`/api/v1/patients/${bOnly}`).set(headers).expect(200);
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId: bOnly }).expect(201);
      expect(visit.body.data.patient.id).toBe(bOnly);

      expect(await linksOf(bOnly)).toEqual([a, b].sort());
      expect((await namesFor(headers)).names).toEqual(['Asma at A', 'Bushra at B', 'Test Patient']);
      expect(await Patient.countDocuments({ phone: BUSHRA_PHONE })).toBe(1);
    });

    test('lets in only the assistant who typed it, and only for a while', async () => {
      const { doctor, a, atA, bOnly } = await aTwoLocationClinic('+92300509');
      const colleague = await aPa(doctor, '+9230050910', [a]);

      await namesFor(at(atA, a), { q: BUSHRA_PHONE });
      await request(app).get(`/api/v1/patients/${bOnly}`).set(at(colleague, a)).expect(404);

      await PatientIntroduction.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      await request(app).get(`/api/v1/patients/${bOnly}`).set(at(atA, a)).expect(404);
      await request(app).post('/api/v1/visits').set(at(atA, a)).send({ patientId: bOnly }).expect(404);
      expect(await linksOf(bOnly)).not.toContain(a);
    });

    test('is nothing special for the doctor, who sees everyone anyway', async () => {
      const { doctor } = await aTwoLocationClinic('+92300510');

      expect((await namesFor(headersFor(doctor), { q: BUSHRA_PHONE })).names).toEqual(['Bushra at B']);
      expect(await PatientIntroduction.countDocuments()).toBe(0);
    });
  });

  test('taking a location off an assistant hides its patients on their next request', async () => {
    const { doctor, a, atBoth, bOnly } = await aTwoLocationClinic('+92300511');
    expect((await namesFor(at(atBoth, a))).names).toContain('Bushra at B');

    const members = await request(app).get('/api/v1/members').set(headersFor(doctor)).expect(200);
    const membership = members.body.data.find((member: { userId: string }) => member.userId === atBoth.userId);
    await request(app)
      .patch(`/api/v1/members/${membership.id}`)
      .set(headersFor(doctor))
      .send({ locationIds: [a] })
      .expect(200);

    expect((await namesFor(at(atBoth, a))).names).toEqual(['Asma at A', 'Test Patient']);
    await request(app).get(`/api/v1/patients/${bOnly}`).set(at(atBoth, a)).expect(404);
  });

  test('the backfill links existing patients from their visits, appointments and prescriptions', async () => {
    const { doctor, a, b, atB, register, fixturePatient, aOnly, bOnly } = await aTwoLocationClinic('+92300512');
    const atBHeaders = headersFor(doctor, { location: b });

    // Seen at B.
    await request(app).post('/api/v1/visits').set(atBHeaders).send({ patientId: aOnly }).expect(201);
    // Booked at B.
    const booked = await register(doctor, 'Booked', a);
    await request(app)
      .post('/api/v1/appointments')
      .set(atBHeaders)
      .send({ patientId: booked, at: '2026-11-02T10:00:00.000Z', kind: 'follow_up' })
      .expect(201);
    // Prescribed at B, with the visit gone, so only the prescription says so.
    const prescribed = await register(doctor, 'Prescribed', a);
    await request(app).post('/api/v1/prescriptions').set(atBHeaders).send({ patientId: prescribed }).expect(201);
    await Visit.deleteMany({ patientId: prescribed });
    // Registered by the assistant at B and never seen.
    const byAssistant = await register(atB, 'By the assistant', b);

    // As they were before patients had locations.
    await Patient.collection.updateMany({}, { $unset: { locationIds: '' } });

    expect(await backfillPatientLocations()).toBe(6);

    expect(await linksOf(aOnly)).toEqual([b]);
    expect(await linksOf(booked)).toEqual([b]);
    expect(await linksOf(prescribed)).toEqual([b]);
    expect(await linksOf(byAssistant)).toEqual([b]);
    // Registered by the doctor and seen nowhere: the default location.
    expect(await linksOf(bOnly)).toEqual([a]);
    expect(await linksOf(fixturePatient)).toEqual([a]);

    // Once is enough.
    expect(await backfillPatientLocations()).toBe(0);
  });
});
