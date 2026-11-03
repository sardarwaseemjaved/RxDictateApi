import { createHash } from 'crypto';
import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config/config';
import { provider } from '../../src/core/sms';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, aPa, headersFor, pause, signIn, waitFor, type SignedIn } from '../fixtures/clinic.fixture';
import { signedIn as openSocket, startLive, type Live } from '../fixtures/realtime.fixture';
import {
  Appointment,
  AuditLog,
  Membership,
  Patient,
  PatientInvite,
  PatientLink,
  Practice,
  Prescription,
  Report,
  Setting,
  Visit,
  Vital,
} from '../../src/models';
import { actionsFor } from '../../src/core/permissions';
import { PORTAL_LINK_DORMANT_DAYS } from '../../src/shared/portal.schema';
import { addDays } from '../../src/utils/time';

setupTestDB();
jest.setTimeout(60_000);

const FAMILY_PHONE = '+923001110001';
const OTHER_PHONE = '+923001110002';

const FAILED = 'PORTAL_LINK_FAILED';

/* ------------------------------------------------------------------ *
 * The clinic's side
 * ------------------------------------------------------------------ */

const setClinic = async (doctor: SignedIn, values: { key: string; value: unknown }[]) =>
  request(app).patch('/api/v1/settings/organisation').set(headersFor(doctor)).send({ values }).expect(200);

const portalOn = (doctor: SignedIn) => setClinic(doctor, [{ key: 'portal.enabled', value: true }]);
const portalOff = (doctor: SignedIn) => setClinic(doctor, [{ key: 'portal.enabled', value: false }]);

/** A clinic with its portal on. */
const aPortalClinic = async (phone: string, name = 'Dr Ayesha') => {
  const { doctor } = await aClinic(phone, name);
  await portalOn(doctor);
  return doctor;
};

const aPatient = async (doctor: SignedIn, name: string, phone: string | null = FAMILY_PHONE): Promise<string> =>
  (
    await request(app)
      .post('/api/v1/patients')
      .set(headersFor(doctor))
      .send({ name, age: 34, sex: 'female', ...(phone ? { phone } : {}) })
      .expect(201)
  ).body.data.id;

/** Written, and signed. Returns the view the doctor gets back, with its verification code. */
const anApproved = async (doctor: SignedIn, patientId: string, extra: object[] = []) => {
  const draft = await aDraft(doctor, patientId);
  await request(app)
    .patch(`/api/v1/prescriptions/${draft.id}`)
    .set(headersFor(doctor, { location: true }))
    .send({
      ops: [
        { op: 'add', section: 'medicines', value: { name: 'Secretol', strength: '500mg' } },
        { op: 'add', section: 'diagnosis', value: { text: 'Hushed diagnosis' } },
        ...extra,
      ],
    })
    .expect(200);
  return (
    await request(app)
      .post(`/api/v1/prescriptions/${draft.id}/approve`)
      .set(headersFor(doctor, { location: true }))
      .expect(200)
  ).body.data;
};

/** Every SMS that goes out during a test. */
const smsSpy = () => jest.spyOn(provider(), 'send');

const lastCodeIn = (body: string): string => body.split('/').pop()!;

/** The ones that are invites: signing in sends a text too. */
const invitesIn = (spy: ReturnType<typeof smsSpy>) =>
  spy.mock.calls.filter(([, body]) => body.includes(config.invite.baseUrl));

const inviteFrom = (actor: SignedIn, patientId: string) =>
  request(app).post(`/api/v1/patients/${patientId}/portal/invite`).set(headersFor(actor));

/** Send an invite and read its code out of the SMS, the only place it exists. */
const anInvite = async (actor: SignedIn, patientId: string): Promise<string> => {
  const spy = smsSpy();
  const before = spy.mock.calls.length;
  await inviteFrom(actor, patientId).expect(200);
  await waitFor(
    async () => spy.mock.calls.length,
    (count) => count > before,
  );
  return lastCodeIn(spy.mock.calls[spy.mock.calls.length - 1][1]);
};

/** So the next invite isn't refused as too soon. */
const aDayPasses = async (patientId: string) => {
  await PatientInvite.updateOne({ patientId }, { $set: { lastSentAt: addDays(new Date(), -2) } });
};

const portalState = async (actor: SignedIn, patientId: string) =>
  (await request(app).get(`/api/v1/patients/${patientId}/portal`).set(headersFor(actor)).expect(200)).body.data;

/* ------------------------------------------------------------------ *
 * The patient's side
 * ------------------------------------------------------------------ */

const bearer = (person: SignedIn) => ({ Authorization: `Bearer ${person.accessToken}` });

const tryLink = (person: SignedIn, kind: string, code: string) =>
  request(app).post('/api/v1/portal/links').set(bearer(person)).send({ kind, code });

const tryPreview = (person: SignedIn, kind: string, code: string) =>
  request(app).post('/api/v1/portal/links/preview').set(bearer(person)).send({ kind, code });

const linkOf = async (person: SignedIn, kind: string, code: string): Promise<string> =>
  (await tryLink(person, kind, code).expect(201)).body.data.id;

const myLinks = async (person: SignedIn) =>
  (await request(app).get('/api/v1/portal/links').set(bearer(person)).expect(200)).body.data;

const read = (person: SignedIn, path: string) => request(app).get(`/api/v1/portal/links/${path}`).set(bearer(person));

/** A signed prescription, and the patient holding it linked. */
const aLinkedPatient = async (doctor: SignedIn, name = 'Zainab Hidden', phone = FAMILY_PHONE) => {
  const patientId = await aPatient(doctor, name, phone);
  const prescription = await anApproved(doctor, patientId);
  const person = await signIn(phone);
  const linkId = await linkOf(person, 'prescription', prescription.verification.code);
  return { patientId, prescription, person, linkId };
};

/** One request of every kind a record route takes, for a link. */
const recordRoutes = (linkId: string, prescriptionId: string) => [
  `${linkId}/prescriptions`,
  `${linkId}/prescriptions/${prescriptionId}`,
  `${linkId}/prescriptions/${prescriptionId}/pdf`,
  `${linkId}/reports`,
  `${linkId}/appointments`,
  `${linkId}/follow-ups`,
  `${linkId}/vitals`,
];

const expectFailed = (response: request.Response) => {
  expect(response.status).toBe(400);
  expect(response.body.error.code).toBe(FAILED);
};

describe('Linking', () => {
  let doctor: SignedIn;

  beforeEach(async () => {
    doctor = await aPortalClinic('+923005550001');
  });

  test('a matching phone and a valid prescription code links, and the preview changes nothing first', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const { verification } = await anApproved(doctor, patientId);
    const person = await signIn(FAMILY_PHONE);

    const preview = await tryPreview(person, 'prescription', verification.code).expect(200);
    expect(preview.body.data).toEqual({
      clinic: { name: expect.any(String) },
      patient: { name: 'Zainab Hidden', age: 34, sex: 'female' },
    });
    expect(await PatientLink.countDocuments()).toBe(0);

    const linked = await tryLink(person, 'prescription', verification.code).expect(201);
    expect(linked.body.data).toMatchObject({ status: 'active', patient: { name: 'Zainab Hidden' } });

    const row = await PatientLink.findById(linked.body.data.id);
    expect(row).toMatchObject({ status: 'active', madeBy: 'prescription' });
    expect(String(row?.userId)).toBe(person.userId);
    expect(String(row?.patientId)).toBe(patientId);
    expect(row?.linkedAt).toBeInstanceOf(Date);
  });

  test('a matching phone and a valid invite links, and using it consumes it', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const code = await anInvite(doctor, patientId);
    const person = await signIn(FAMILY_PHONE);

    await tryPreview(person, 'invite', code).expect(200);
    expect((await PatientInvite.findOne({ patientId }))?.usedAt).toBeNull();

    const linkId = await linkOf(person, 'invite', code);
    expect((await PatientLink.findById(linkId))?.madeBy).toBe('invite');
    expect((await PatientInvite.findOne({ patientId }))?.usedAt).toBeInstanceOf(Date);
  });

  test('a phone match with no code links nothing', async () => {
    await aPatient(doctor, 'Zainab Hidden');
    const person = await signIn(FAMILY_PHONE);

    await request(app).post('/api/v1/portal/links').set(bearer(person)).send({ kind: 'invite' }).expect(400);
    await request(app).post('/api/v1/portal/links').set(bearer(person)).send({}).expect(400);
    expect(await PatientLink.countDocuments()).toBe(0);
    expect(await myLinks(person)).toEqual([]);
  });

  describe('every refusal is the same answer', () => {
    let answerToUnknown: { error: object };

    beforeEach(async () => {
      const person = await signIn('+923009990001');
      answerToUnknown = (await tryLink(person, 'invite', 'A'.repeat(22))).body;
    });

    test('an unknown code, which is what the rest are compared with', () => {
      expect(answerToUnknown.error).toMatchObject({ code: FAILED });
    });

    const sameAnswer = (response: request.Response) => {
      expect(response.status).toBe(400);
      expect(response.body).toEqual(answerToUnknown);
    };

    test('a valid code from a different phone', async () => {
      const patientId = await aPatient(doctor, 'Zainab Hidden');
      const { verification } = await anApproved(doctor, patientId);
      const code = await anInvite(doctor, patientId);
      const stranger = await signIn(OTHER_PHONE);

      sameAnswer(await tryLink(stranger, 'prescription', verification.code));
      sameAnswer(await tryPreview(stranger, 'prescription', verification.code));
      sameAnswer(await tryLink(stranger, 'invite', code));
      expect(await PatientLink.countDocuments()).toBe(0);
      // A wrong phone didn't spend it.
      expect((await PatientInvite.findOne({ patientId }))?.usedAt).toBeNull();
    });

    test('a malformed code, and a code of the wrong kind', async () => {
      const patientId = await aPatient(doctor, 'Zainab Hidden');
      const { verification } = await anApproved(doctor, patientId);
      const person = await signIn(FAMILY_PHONE);

      sameAnswer(await tryLink(person, 'invite', 'not a code'));
      sameAnswer(await tryLink(person, 'invite', verification.code));
    });

    test('the portal off', async () => {
      const patientId = await aPatient(doctor, 'Zainab Hidden');
      const { verification } = await anApproved(doctor, patientId);
      await portalOff(doctor);
      const person = await signIn(FAMILY_PHONE);

      sameAnswer(await tryLink(person, 'prescription', verification.code));
      sameAnswer(await tryPreview(person, 'prescription', verification.code));
    });

    test('a clinic that never turned it on: off is the default', async () => {
      const { doctor: another } = await aClinic('+923005550009');
      const patientId = await aPatient(another, 'Zainab Hidden');
      const { verification } = await anApproved(another, patientId);

      sameAnswer(await tryLink(await signIn(FAMILY_PHONE), 'prescription', verification.code));
    });

    test('a blocked record', async () => {
      const patientId = await aPatient(doctor, 'Zainab Hidden');
      const { verification } = await anApproved(doctor, patientId);
      await request(app)
        .patch(`/api/v1/patients/${patientId}/portal`)
        .set(headersFor(doctor))
        .send({ blocked: true })
        .expect(200);

      sameAnswer(await tryLink(await signIn(FAMILY_PHONE), 'prescription', verification.code));
    });

    test('a deleted record', async () => {
      const patientId = await aPatient(doctor, 'Zainab Hidden');
      const { verification } = await anApproved(doctor, patientId);
      await Patient.updateOne({ _id: patientId }, { $set: { deletedAt: new Date() } });

      sameAnswer(await tryLink(await signIn(FAMILY_PHONE), 'prescription', verification.code));
    });

    test('a record already linked to somebody else', async () => {
      const patientId = await aPatient(doctor, 'Zainab Hidden');
      const { verification } = await anApproved(doctor, patientId);
      const now = new Date();
      const other = await signIn(OTHER_PHONE);
      await PatientLink.create({
        userId: other.userId,
        patientId,
        practiceId: doctor.practiceId,
        madeBy: 'invite',
        linkedAt: now,
        lastUsedAt: now,
      });

      sameAnswer(await tryLink(await signIn(FAMILY_PHONE), 'prescription', verification.code));
    });

    test('a used, an expired and a replaced invite', async () => {
      const usedFor = await aPatient(doctor, 'Used');
      const used = await anInvite(doctor, usedFor);
      const person = await signIn(FAMILY_PHONE);
      const linkId = await linkOf(person, 'invite', used);
      // Once the link is gone, the code that made it can't make another.
      await request(app).delete(`/api/v1/portal/links/${linkId}`).set(bearer(person)).expect(200);
      sameAnswer(await tryLink(person, 'invite', used));

      const expiredFor = await aPatient(doctor, 'Expired');
      const expired = await anInvite(doctor, expiredFor);
      await PatientInvite.updateOne({ patientId: expiredFor }, { $set: { expiresAt: addDays(new Date(), -1) } });
      sameAnswer(await tryLink(person, 'invite', expired));

      const replacedFor = await aPatient(doctor, 'Replaced');
      const replaced = await anInvite(doctor, replacedFor);
      await aDayPasses(replacedFor);
      const replacement = await anInvite(doctor, replacedFor);
      sameAnswer(await tryLink(person, 'invite', replaced));
      await tryLink(person, 'invite', replacement).expect(201);
    });

    test("a draft has no code to try, and a cancelled prescription's is refused", async () => {
      const patientId = await aPatient(doctor, 'Zainab Hidden');
      const draft = await aDraft(doctor, patientId);
      expect(draft.verification).toBeNull();
      const person = await signIn(FAMILY_PHONE);

      await Prescription.updateOne({ _id: draft.id }, { $set: { status: 'cancelled', verificationCode: 'C'.repeat(22) } });
      sameAnswer(await tryLink(person, 'prescription', 'C'.repeat(22)));
      sameAnswer(await tryPreview(person, 'prescription', 'C'.repeat(22)));
    });
  });

  test('a family phone with two records links only the one the code belongs to', async () => {
    const child = await aPatient(doctor, 'Child One');
    const grownUp = await aPatient(doctor, 'Grown Up');
    const forChild = await anApproved(doctor, child);
    const forGrownUp = await anApproved(doctor, grownUp);
    const parent = await signIn(FAMILY_PHONE);

    const linkId = await linkOf(parent, 'prescription', forChild.verification.code);

    const links = await myLinks(parent);
    expect(links).toHaveLength(1);
    expect(links[0].patient.name).toBe('Child One');

    const seen = await read(parent, `${linkId}/prescriptions`).expect(200);
    expect(seen.body.data.map((row: { id: string }) => row.id)).toEqual([forChild.id]);
    await read(parent, `${linkId}/prescriptions/${forGrownUp.id}`).expect(404);

    // Each record is linked on its own, and one account may hold both.
    await linkOf(parent, 'prescription', forGrownUp.verification.code);
    expect(await myLinks(parent)).toHaveLength(2);
  });

  test('linking your own link again just succeeds, with the same or a different code', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const { verification } = await anApproved(doctor, patientId);
    const code = await anInvite(doctor, patientId);
    const person = await signIn(FAMILY_PHONE);

    const first = await tryLink(person, 'invite', code).expect(201);
    const again = await tryLink(person, 'invite', code).expect(200);
    const another = await tryLink(person, 'prescription', verification.code).expect(200);

    expect(again.body.data.id).toBe(first.body.data.id);
    expect(another.body.data.id).toBe(first.body.data.id);
    expect(await PatientLink.countDocuments()).toBe(1);
  });

  test('the database holds at most one active link per record', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const now = new Date();
    const row = (userId: string) => ({
      userId,
      patientId,
      practiceId: doctor.practiceId,
      madeBy: 'invite',
      linkedAt: now,
      lastUsedAt: now,
    });
    const [a, b] = await Promise.all([signIn(FAMILY_PHONE), signIn(OTHER_PHONE)]);

    await PatientLink.create(row(a.userId));
    await expect(PatientLink.create(row(b.userId))).rejects.toMatchObject({ code: 11000 });
  });

  test('the same person may hold records at different clinics', async () => {
    await aLinkedPatient(doctor);
    const another = await aPortalClinic('+923005550002', 'Dr Bilal');
    const elsewhere = await aPatient(another, 'Zainab Elsewhere');
    const signedThere = await anApproved(another, elsewhere);
    const person = await signIn(FAMILY_PHONE);

    await linkOf(person, 'prescription', signedThere.verification.code);

    expect((await myLinks(person)).map((link: { patient: { name: string } }) => link.patient.name).sort()).toEqual([
      'Zainab Elsewhere',
      'Zainab Hidden',
    ]);
  });

  test('audited, with no code in the trail', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const code = await anInvite(doctor, patientId);
    const person = await signIn(FAMILY_PHONE);
    const linkId = await linkOf(person, 'invite', code);

    const entry = await AuditLog.findOne({ action: 'patient.portal.link', entityId: linkId });
    expect(entry).toMatchObject({ role: 'patient', entity: 'patientLink' });
    expect(String(entry?.actorId)).toBe(person.userId);
    expect(String(entry?.practiceId)).toBe(doctor.practiceId);

    const trail = JSON.stringify(await AuditLog.find({ action: /^patient\.portal/ }));
    expect(trail).not.toContain(code);
    expect(trail).not.toContain(FAMILY_PHONE);
  });
});

describe('A patient is not a member of a clinic', () => {
  test('signing in creates no clinic and no membership, and /me says how many records they hold', async () => {
    const doctor = await aPortalClinic('+923005550001');
    const clinics = await Practice.countDocuments();

    const { person } = await aLinkedPatient(doctor);

    expect(await Practice.countDocuments()).toBe(clinics);
    expect(await Membership.countDocuments({ userId: person.userId })).toBe(0);

    const me = await request(app).get('/api/v1/me').set(bearer(person)).expect(200);
    expect(me.body.data.memberships).toEqual([]);
    expect(me.body.data.portalLinks).toBe(1);

    const staff = await request(app).get('/api/v1/me').set(bearer(doctor)).expect(200);
    expect(staff.body.data.portalLinks).toBe(0);
  });

  test('a linked patient is refused on every clinic route, with the clinic named or not', async () => {
    const doctor = await aPortalClinic('+923005550001');
    const { person, patientId, prescription } = await aLinkedPatient(doctor);

    const routes: [string, string][] = [
      ['get', '/api/v1/patients'],
      ['get', `/api/v1/patients/${patientId}`],
      ['patch', `/api/v1/patients/${patientId}`],
      ['get', `/api/v1/patients/${patientId}/history`],
      ['get', `/api/v1/patients/${patientId}/reports`],
      ['get', `/api/v1/patients/${patientId}/portal`],
      ['post', `/api/v1/patients/${patientId}/portal/invite`],
      ['patch', `/api/v1/patients/${patientId}/portal`],
      ['delete', `/api/v1/patients/${patientId}/portal/link`],
      ['get', '/api/v1/visits'],
      ['get', '/api/v1/prescriptions'],
      ['get', `/api/v1/prescriptions/${prescription.id}`],
      ['get', `/api/v1/prescriptions/${prescription.id}/pdf`],
      ['get', '/api/v1/appointments?from=2026-10-01&to=2026-10-31'],
      ['get', '/api/v1/follow-ups'],
      ['post', '/api/v1/reports/uploads'],
      ['get', '/api/v1/practice'],
      ['get', '/api/v1/locations'],
      ['get', '/api/v1/members'],
      ['get', '/api/v1/drugs?q=a'],
      ['get', '/api/v1/drug-lists/me'],
      ['get', '/api/v1/templates'],
      ['get', '/api/v1/notifications'],
      ['get', '/api/v1/settings'],
    ];

    for (let i = 0; i < routes.length; i += 1) {
      const [method, path] = routes[i];
      const agent = request(app) as unknown as Record<string, (url: string) => request.Test>;
      // eslint-disable-next-line no-await-in-loop
      const named = await agent[method](path)
        .set({ ...bearer(person), 'X-Practice-Id': doctor.practiceId, 'X-Location-Id': doctor.locationId })
        .send({});
      expect({ path, code: named.body.error?.code }).toEqual({ path, code: 'NOT_MEMBER' });

      // eslint-disable-next-line no-await-in-loop
      const unnamed = await agent[method](path).set(bearer(person)).send({});
      expect({ path, code: unnamed.body.error?.code }).toEqual({ path, code: 'PRACTICE_REQUIRED' });
    }
  });

  test('the role stays reserved: it holds no action', () => {
    expect(actionsFor('patient')).toEqual([]);
  });
});

describe('Isolation', () => {
  let doctor: SignedIn;

  beforeEach(async () => {
    doctor = await aPortalClinic('+923005550001');
  });

  test("another user's link answers NOT_FOUND on every record route, and can't be removed", async () => {
    const { linkId, prescription } = await aLinkedPatient(doctor);
    const stranger = await signIn(OTHER_PHONE);
    const routes = recordRoutes(linkId, prescription.id);

    const answers = await Promise.all(routes.map((path) => read(stranger, path)));
    answers.forEach((answer, at) => {
      expect({ path: routes[at], status: answer.status, code: answer.body.error?.code }).toEqual({
        path: routes[at],
        status: 404,
        code: 'NOT_FOUND',
      });
    });

    await request(app)
      .post(`/api/v1/portal/links/${linkId}/uploads`)
      .set(bearer(stranger))
      .send({ contentType: 'image/jpeg', size: 10 })
      .expect(404);
    await request(app).delete(`/api/v1/portal/links/${linkId}`).set(bearer(stranger)).expect(404);
    expect((await PatientLink.findById(linkId))?.status).toBe('active');
  });

  test('every record route needs sign-in', async () => {
    const { linkId, prescription } = await aLinkedPatient(doctor);
    await Promise.all(
      recordRoutes(linkId, prescription.id).map((path) => request(app).get(`/api/v1/portal/links/${path}`).expect(401)),
    );
    await request(app).get('/api/v1/portal/links').expect(401);
    await request(app).post('/api/v1/portal/links').send({ kind: 'invite', code: 'x' }).expect(401);
  });

  test('a link at one clinic shows nothing from another, for the same phone', async () => {
    const { person, linkId } = await aLinkedPatient(doctor);

    const another = await aPortalClinic('+923005550002', 'Dr Bilal');
    const elsewhere = await aPatient(another, 'Zainab Hidden');
    const signedThere = await anApproved(another, elsewhere);

    const list = await read(person, `${linkId}/prescriptions`).expect(200);
    expect(list.body.data.map((row: { id: string }) => row.id)).not.toContain(signedThere.id);
    expect(list.body.data).toHaveLength(1);
    await read(person, `${linkId}/prescriptions/${signedThere.id}`).expect(404);
    await read(person, `${linkId}/prescriptions/${signedThere.id}/pdf`).expect(404);
  });

  test('drafts never appear, including a revision being written', async () => {
    const { person, linkId, patientId, prescription } = await aLinkedPatient(doctor);

    const draft = await aDraft(doctor, patientId);
    const seesOnlyTheSigned = async () => {
      const list = await read(person, `${linkId}/prescriptions`).expect(200);
      expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([prescription.id]);
      expect(list.body.data[0].status).toBe('approved');
    };

    await seesOnlyTheSigned();
    await read(person, `${linkId}/prescriptions/${draft.id}`).expect(404);
    await read(person, `${linkId}/prescriptions/${draft.id}/pdf`).expect(404);

    // A visit holds one draft at a time, so that one goes before a revision can start.
    await request(app)
      .post(`/api/v1/prescriptions/${draft.id}/cancel`)
      .set(headersFor(doctor, { location: true }))
      .expect(200);
    await read(person, `${linkId}/prescriptions/${draft.id}`).expect(404);

    const revision = await request(app)
      .post(`/api/v1/prescriptions/${prescription.id}/revise`)
      .set(headersFor(doctor, { location: true }))
      .send({ reason: 'Changing the dose' })
      .expect(201);

    await seesOnlyTheSigned();
    await read(person, `${linkId}/prescriptions/${revision.body.data.id}`).expect(404);
  });

  test('a superseded one is marked and names what replaced it', async () => {
    const { person, linkId, prescription } = await aLinkedPatient(doctor);

    const revision = await request(app)
      .post(`/api/v1/prescriptions/${prescription.id}/revise`)
      .set(headersFor(doctor, { location: true }))
      .send({ reason: 'Changing the dose' })
      .expect(201);
    const signed = await request(app)
      .post(`/api/v1/prescriptions/${revision.body.data.id}/approve`)
      .set(headersFor(doctor, { location: true }))
      .expect(200);

    const list = await read(person, `${linkId}/prescriptions`).expect(200);
    expect(list.body.meta).toMatchObject({ page: 1, total: 2 });
    expect(list.body.data[0]).toMatchObject({ id: signed.body.data.id, status: 'approved', replacedBy: null });
    expect(list.body.data[1]).toMatchObject({
      id: prescription.id,
      status: 'superseded',
      replacedBy: { id: signed.body.data.id, number: signed.body.data.number },
    });
  });

  test('a prescription reads as printed, with its code, and no edit log, span or internal field', async () => {
    const { person, linkId, prescription } = await aLinkedPatient(doctor);
    await Prescription.updateOne(
      { _id: prescription.id },
      {
        $set: {
          editLog: [{ at: new Date(), by: doctor.userId, section: 'medicines', itemId: 'x', from: 'old-secret', to: 'y' }],
        },
      },
    );

    const { body } = await read(person, `${linkId}/prescriptions/${prescription.id}`).expect(200);
    const { data } = body;

    expect(data).toMatchObject({
      id: prescription.id,
      number: prescription.number,
      status: 'approved',
      patient: { name: 'Zainab Hidden', age: 34, sex: 'female' },
      letterhead: { doctorName: 'Dr Ayesha' },
      verification: prescription.verification,
    });
    expect(data.sections.medicines[0]).toEqual(
      expect.objectContaining({ name: 'Secretol', strength: '500mg', pattern: { m: 1, a: 0, n: 0 } }),
    );
    expect(Object.keys(data).sort()).toEqual(
      [
        'approvedAt',
        'doctorName',
        'id',
        'letterhead',
        'locationName',
        'number',
        'patient',
        'printLanguage',
        'replacedBy',
        'sections',
        'status',
        'verification',
        'version',
      ].sort(),
    );

    const text = JSON.stringify(body);
    [
      'editLog',
      'old-secret',
      'sourceSpanIds',
      'drugId',
      'correctedBySpeech',
      'flags',
      'practiceId',
      'patientId',
      'locationId',
      'visitId',
      'doctorId',
      'approvedBy',
      'createdBy',
      'pdfKey',
      'source',
      'transcript',
      'mrNo',
      'phone":"+',
      'bookByAssistant',
    ].forEach((secret) => {
      expect({ secret, found: text.includes(secret) }).toEqual({ secret, found: false });
    });
  });

  test('the print file is a short-lived link, as staff get, and is audited', async () => {
    const { person, linkId, prescription } = await aLinkedPatient(doctor);

    const { body } = await read(person, `${linkId}/prescriptions/${prescription.id}/pdf`).expect(200);

    expect(Object.keys(body.data).sort()).toEqual(['contentType', 'expiresAt', 'url']);
    expect(body.data.url).toContain('sig=');
    expect(await AuditLog.countDocuments({ action: 'prescription.print', role: 'patient' })).toBe(1);
  });

  test('reports come with signed page links and nothing about who filed them', async () => {
    const { person, linkId, patientId } = await aLinkedPatient(doctor);
    const ticket = await request(app)
      .post('/api/v1/reports/uploads')
      .set(headersFor(doctor))
      .send({ contentType: 'image/jpeg', size: 10 })
      .expect(201);
    const filed = await request(app)
      .post(`/api/v1/patients/${patientId}/reports`)
      .set(headersFor(doctor))
      .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: [ticket.body.data.fileKey] })
      .expect(201);

    const list = await read(person, `${linkId}/reports`).expect(200);
    expect(list.body.data).toEqual([
      {
        id: filed.body.data.id,
        type: 'lab',
        testName: 'CBC',
        testDate: '2026-10-01',
        pages: 1,
        source: 'clinic',
        reviewed: false,
        createdAt: expect.any(String),
      },
    ]);

    const one = await read(person, `${linkId}/reports/${filed.body.data.id}`).expect(200);
    expect(one.body.data.pageUrls).toHaveLength(1);
    expect(one.body.data.pageUrls[0].url).toContain('sig=');
    expect(JSON.stringify(one.body)).not.toContain('uploadedBy');
    expect(JSON.stringify(one.body)).not.toContain('pageKeys');
  });

  test('appointments: upcoming and past, cancelled only when asked for, and no staff note', async () => {
    const { person, linkId, patientId } = await aLinkedPatient(doctor);
    const book = (at: Date) =>
      request(app)
        .post('/api/v1/appointments')
        .set(headersFor(doctor, { location: true }))
        .send({ patientId, at, kind: 'follow_up', note: 'Staff-only remark' })
        .expect(201);
    const soon = await book(addDays(new Date(), 3));
    const later = await book(addDays(new Date(), 6));
    const gone = await book(addDays(new Date(), 9));
    await request(app)
      .post(`/api/v1/appointments/${gone.body.data.id}/cancel`)
      .set(headersFor(doctor, { location: true }))
      .expect(200);
    const past = await book(addDays(new Date(), 1));
    await Appointment.updateOne({ _id: past.body.data.id }, { $set: { at: addDays(new Date(), -5) } });

    const ids = (response: request.Response) => response.body.data.map((row: { id: string }) => row.id);

    const upcoming = await read(person, `${linkId}/appointments?when=upcoming`).expect(200);
    expect(ids(upcoming)).toEqual([soon.body.data.id, later.body.data.id]);

    const before = await read(person, `${linkId}/appointments?when=past`).expect(200);
    expect(ids(before)).toEqual([past.body.data.id]);

    const both = await read(person, `${linkId}/appointments`).expect(200);
    expect(ids(both)).toEqual([later.body.data.id, soon.body.data.id, past.body.data.id]);

    const withCancelled = await read(person, `${linkId}/appointments?when=upcoming&includeCancelled=true`).expect(200);
    expect(ids(withCancelled)).toContain(gone.body.data.id);

    expect(Object.keys(upcoming.body.data[0]).sort()).toEqual(['at', 'id', 'kind', 'locationName', 'status']);
    expect(JSON.stringify(both.body)).not.toContain('Staff-only remark');
  });

  test('follow-ups, whether or not the assistant was asked to book them', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const signed = await anApproved(doctor, patientId, [
      { op: 'update', section: 'followUp', value: { inDays: 7, note: 'Bring the reports', bookByAssistant: false } },
    ]);
    const person = await signIn(FAMILY_PHONE);
    const linkId = await linkOf(person, 'prescription', signed.verification.code);

    const { body } = await read(person, `${linkId}/follow-ups`).expect(200);
    expect(body.data).toEqual([
      {
        prescriptionId: signed.id,
        dueDate: expect.any(String),
        note: 'Bring the reports',
        booked: false,
        isOverdue: false,
      },
    ]);
  });

  test('vitals over time, from finished visits, without complaints or who took them', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const draft = await aDraft(doctor, patientId);
    await request(app)
      .put(`/api/v1/visits/${draft.visitId}/vitals`)
      .set(headersFor(doctor, { location: true }))
      .send({ bp: '120/80', pulse: 72, complaints: 'Private words at the desk' })
      .expect(200);
    await request(app)
      .patch(`/api/v1/prescriptions/${draft.id}`)
      .set(headersFor(doctor, { location: true }))
      .send({ ops: [{ op: 'add', section: 'medicines', value: { name: 'Secretol' } }] })
      .expect(200);

    const signed = await request(app)
      .post(`/api/v1/prescriptions/${draft.id}/approve`)
      .set(headersFor(doctor, { location: true }))
      .expect(200);
    const person = await signIn(FAMILY_PHONE);
    const linkId = await linkOf(person, 'prescription', signed.body.data.verification.code);

    const { body } = await read(person, `${linkId}/vitals`).expect(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ bp: '120/80', pulse: 72 });
    expect(Object.keys(body.data[0]).sort()).toEqual(
      ['bloodSugarRandom', 'bp', 'id', 'pulse', 'recordedAt', 'spo2', 'tempF', 'weightKg'].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('Private words');

    // The same reading on a visit still in progress isn't final.
    await Visit.updateOne({ _id: draft.visitId }, { $set: { status: 'with_doctor' } });
    expect((await read(person, `${linkId}/vitals`).expect(200)).body.data).toEqual([]);
    expect(await Vital.countDocuments()).toBe(1);
  });
});

describe('When a link ends', () => {
  let doctor: SignedIn;

  beforeEach(async () => {
    doctor = await aPortalClinic('+923005550001');
  });

  const lapse = async (linkId: string) => {
    await PatientLink.updateOne(
      { _id: linkId },
      { $set: { lastUsedAt: addDays(new Date(), -PORTAL_LINK_DORMANT_DAYS - 1) } },
    );
  };

  test('a changed phone ends it at once, audited, and takes any dormant link and invite with it', async () => {
    const { person, linkId, patientId, prescription } = await aLinkedPatient(doctor);

    await request(app)
      .patch(`/api/v1/patients/${patientId}`)
      .set(headersFor(doctor))
      .send({ phone: OTHER_PHONE })
      .expect(200);

    expect(await PatientLink.findById(linkId)).toMatchObject({ status: 'removed', removedReason: 'phoneChanged' });
    expect(String((await PatientLink.findById(linkId))?.removedBy)).toBe(doctor.userId);
    expect(await AuditLog.countDocuments({ action: 'patient.portal.unlink', entityId: linkId })).toBe(1);

    await read(person, `${linkId}/prescriptions`).expect(404);
    expect(await myLinks(person)).toEqual([]);

    // The old number can't come back with the old paper, and the new one has to ask.
    expectFailed(await tryLink(person, 'prescription', prescription.verification.code));
    const holder = await signIn(OTHER_PHONE);
    await linkOf(holder, 'prescription', prescription.verification.code);
  });

  test('saving the same phone, or another field, ends nothing', async () => {
    const { linkId, patientId } = await aLinkedPatient(doctor);

    await request(app)
      .patch(`/api/v1/patients/${patientId}`)
      .set(headersFor(doctor))
      .send({ phone: FAMILY_PHONE, name: 'Zainab H' })
      .expect(200);

    expect((await PatientLink.findById(linkId))?.status).toBe('active');
  });

  test('a phone changed underneath a link serves nothing, even before anything ends it', async () => {
    const { person, linkId, patientId } = await aLinkedPatient(doctor);
    await Patient.updateOne({ _id: patientId }, { $set: { phone: OTHER_PHONE } });

    const answer = await read(person, `${linkId}/prescriptions`);
    expect(answer.status).toBe(403);
    expect(answer.body.error.code).toBe('PORTAL_LINK_UNAVAILABLE');
  });

  test('180 unused days makes it dormant on the next access, and a new code revives it', async () => {
    const { person, linkId, prescription } = await aLinkedPatient(doctor);
    await lapse(linkId);

    const answer = await read(person, `${linkId}/prescriptions`);
    expect(answer.status).toBe(403);
    expect(answer.body.error.code).toBe('PORTAL_LINK_UNAVAILABLE');
    expect((await PatientLink.findById(linkId))?.status).toBe('dormant');
    expect(await AuditLog.countDocuments({ action: 'patient.portal.dormant', entityId: linkId })).toBe(1);

    expect((await myLinks(person))[0].status).toBe('dormant');
    expect((await portalState(doctor, String((await PatientLink.findById(linkId))?.patientId))).status).toBe('dormant');

    const revived = await tryLink(person, 'prescription', prescription.verification.code).expect(200);
    expect(revived.body.data).toMatchObject({ id: linkId, status: 'active' });
    expect(await AuditLog.countDocuments({ action: 'patient.portal.revive', entityId: linkId })).toBe(1);
    await read(person, `${linkId}/prescriptions`).expect(200);
    expect(await PatientLink.countDocuments()).toBe(1);
  });

  test('one day short of it still serves, and the list alone shows the change', async () => {
    const { person, linkId } = await aLinkedPatient(doctor);

    await PatientLink.updateOne(
      { _id: linkId },
      { $set: { lastUsedAt: addDays(new Date(), -PORTAL_LINK_DORMANT_DAYS + 1) } },
    );
    await read(person, `${linkId}/prescriptions`).expect(200);

    await lapse(linkId);
    expect((await myLinks(person))[0].status).toBe('dormant');
    expect((await PatientLink.findById(linkId))?.status).toBe('dormant');
  });

  test('a used invite can revive nothing, and a new one can', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const code = await anInvite(doctor, patientId);
    const person = await signIn(FAMILY_PHONE);
    const linkId = await linkOf(person, 'invite', code);
    await lapse(linkId);

    expectFailed(await tryLink(person, 'invite', code));
    expect((await PatientLink.findById(linkId))?.lastUsedAt.getTime()).toBeLessThan(Date.now() - 1000);

    await aDayPasses(patientId);
    const fresh = await anInvite(doctor, patientId);
    await tryLink(person, 'invite', fresh).expect(200);
    await read(person, `${linkId}/prescriptions`).expect(200);
  });

  test('lastUsedAt moves at most once a day', async () => {
    const { person, linkId } = await aLinkedPatient(doctor);

    const untouched = (await PatientLink.findById(linkId))!.lastUsedAt.getTime();
    await pause(5);
    await read(person, `${linkId}/prescriptions`).expect(200);
    expect((await PatientLink.findById(linkId))!.lastUsedAt.getTime()).toBe(untouched);

    await PatientLink.updateOne({ _id: linkId }, { $set: { lastUsedAt: addDays(new Date(), -2) } });
    await read(person, `${linkId}/prescriptions`).expect(200);
    expect((await PatientLink.findById(linkId))!.lastUsedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  test('blocking ends it, and unblocking brings back nothing', async () => {
    const { person, linkId, patientId, prescription } = await aLinkedPatient(doctor);

    const blocked = await request(app)
      .patch(`/api/v1/patients/${patientId}/portal`)
      .set(headersFor(doctor))
      .send({ blocked: true })
      .expect(200);
    expect(blocked.body.data).toMatchObject({ status: 'none', blocked: true, linkedAt: null });
    expect(await PatientLink.findById(linkId)).toMatchObject({ status: 'removed', removedReason: 'blocked' });
    await read(person, `${linkId}/prescriptions`).expect(404);
    expectFailed(await tryLink(person, 'prescription', prescription.verification.code));

    await request(app)
      .patch(`/api/v1/patients/${patientId}/portal`)
      .set(headersFor(doctor))
      .send({ blocked: false })
      .expect(200);
    expect(await myLinks(person)).toEqual([]);
    await read(person, `${linkId}/prescriptions`).expect(404);
    // They can link again, with a code, as anybody can.
    await tryLink(person, 'prescription', prescription.verification.code).expect(201);
  });

  test('portal off serves nothing and keeps the link; on again restores it', async () => {
    const { person, linkId, prescription } = await aLinkedPatient(doctor);

    await portalOff(doctor);

    const routes = recordRoutes(linkId, prescription.id);
    const answers = await Promise.all(routes.map((path) => read(person, path)));
    answers.forEach((answer, at) => {
      expect({ path: routes[at], code: answer.body.error?.code }).toEqual({
        path: routes[at],
        code: 'PORTAL_LINK_UNAVAILABLE',
      });
    });
    expect((await myLinks(person))[0].status).toBe('unavailable');
    expect((await PatientLink.findById(linkId))?.status).toBe('active');

    await portalOn(doctor);

    expect((await myLinks(person))[0].status).toBe('active');
    await read(person, `${linkId}/prescriptions`).expect(200);
  });

  test('a platform lock turning the portal off beats the clinic', async () => {
    const { person, linkId } = await aLinkedPatient(doctor);
    await Setting.create({
      layer: 'platform',
      organisationId: null,
      userId: null,
      key: 'portal.enabled',
      value: false,
      locked: true,
      updatedBy: doctor.userId,
    });

    expect((await read(person, `${linkId}/prescriptions`)).body.error.code).toBe('PORTAL_LINK_UNAVAILABLE');
  });

  test('the patient can remove it, and it stays gone until a code says otherwise', async () => {
    const { person, linkId, prescription } = await aLinkedPatient(doctor);

    const gone = await request(app).delete(`/api/v1/portal/links/${linkId}`).set(bearer(person)).expect(200);
    expect(gone.body.data).toEqual({ removed: true });
    expect(await PatientLink.findById(linkId)).toMatchObject({ status: 'removed', removedReason: 'patient' });
    expect(String((await PatientLink.findById(linkId))?.removedBy)).toBe(person.userId);
    expect(await AuditLog.countDocuments({ action: 'patient.portal.unlink', entityId: linkId })).toBe(1);

    await read(person, `${linkId}/prescriptions`).expect(404);
    await request(app).delete(`/api/v1/portal/links/${linkId}`).set(bearer(person)).expect(404);
    expect((await request(app).get('/api/v1/me').set(bearer(person))).body.data.portalLinks).toBe(0);

    const again = await tryLink(person, 'prescription', prescription.verification.code).expect(201);
    expect(again.body.data.id).not.toBe(linkId);
  });

  test('a patient can remove a dormant link too', async () => {
    const { person, linkId } = await aLinkedPatient(doctor);
    await lapse(linkId);
    await myLinks(person);
    await request(app).delete(`/api/v1/portal/links/${linkId}`).set(bearer(person)).expect(200);
  });

  test('the clinic can remove it, and a second tap changes nothing', async () => {
    const { person, linkId, patientId } = await aLinkedPatient(doctor);

    const removed = await request(app)
      .delete(`/api/v1/patients/${patientId}/portal/link`)
      .set(headersFor(doctor))
      .expect(200);
    expect(removed.body.data).toMatchObject({ status: 'none', linkedAt: null });
    expect(await PatientLink.findById(linkId)).toMatchObject({ status: 'removed', removedReason: 'clinic' });
    await read(person, `${linkId}/prescriptions`).expect(404);

    await request(app).delete(`/api/v1/patients/${patientId}/portal/link`).set(headersFor(doctor)).expect(200);
    expect(await AuditLog.countDocuments({ action: 'patient.portal.unlink', entityId: linkId })).toBe(1);
  });
});

describe('Invites', () => {
  let doctor: SignedIn;

  beforeEach(async () => {
    doctor = await aPortalClinic('+923005550001', 'Dr Ayesha');
  });

  const setAuto = (actor: SignedIn) => setClinic(actor, [{ key: 'portal.invites', value: 'auto' }]);

  /** Long enough for a listener that was going to send something to have sent it. */
  const settle = () => pause(150);

  test('the code is stored only as a hash, and expires in 30 days', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const code = await anInvite(doctor, patientId);

    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const row = await PatientInvite.findOne({ patientId }).lean();
    expect(row?.codeHash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(code);
    expect(JSON.stringify(await AuditLog.find({ action: 'patient.portal.invite' }))).not.toContain(code);

    const days = ((row?.expiresAt?.getTime() ?? 0) - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  test('the SMS links at the page, names the clinic and doctor, and nothing about the patient', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    await anApproved(doctor, patientId);
    const spy = smsSpy();
    const code = await anInvite(doctor, patientId);

    const [to, body] = spy.mock.calls[spy.mock.calls.length - 1];
    const practice = await Practice.findById(doctor.practiceId);
    expect(to).toBe(FAMILY_PHONE);
    expect(body).toContain(`${config.invite.baseUrl}/${code}`);
    expect(body).toContain('Dr Ayesha');
    expect(body).toContain(practice!.name);
    expect(body).toContain('your prescription is ready to view');
    ['Zainab', 'Hidden', 'Secretol', 'diagnosis'].forEach((secret) => {
      expect(body).not.toContain(secret);
    });
  });

  test("an assistant's invite doesn't call the assistant a doctor, and promises no prescription that isn't there", async () => {
    const pa = await aPa(doctor, '+923005550003');
    const patientId = await aPatient(pa, 'Zainab Hidden');
    const spy = smsSpy();

    await anInvite(pa, patientId);

    const [, body] = spy.mock.calls[spy.mock.calls.length - 1];
    expect(body).not.toContain('Dr.');
    expect(body).not.toContain('Sana');
    expect(body).not.toContain('prescription');
  });

  test('manual: at most one per record per 24 hours, with a code the apps can show', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const other = await aPatient(doctor, 'Someone Else', OTHER_PHONE);
    await anInvite(doctor, patientId);
    const spy = smsSpy();
    spy.mockClear();

    const again = await inviteFrom(doctor, patientId).expect(429);
    expect(again.body.error.code).toBe('PORTAL_INVITE_TOO_SOON');
    expect(new Date(again.body.error.details.retryAt).getTime()).toBeGreaterThan(Date.now());

    // Per record, not per clinic.
    await inviteFrom(doctor, other).expect(200);
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);

    await aDayPasses(patientId);
    await inviteFrom(doctor, patientId).expect(200);
  });

  test('two taps at once send one', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const spy = smsSpy();

    const answers = await Promise.all([inviteFrom(doctor, patientId), inviteFrom(doctor, patientId)]);

    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 429]);
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('manual is refused with the portal off, no phone, a blocked record, or one already linked', async () => {
    const noPhone = await aPatient(doctor, 'No Phone', null);
    expect((await inviteFrom(doctor, noPhone)).body.error.code).toBe('VALIDATION_ERROR');

    const blocked = await aPatient(doctor, 'Blocked');
    await request(app)
      .patch(`/api/v1/patients/${blocked}/portal`)
      .set(headersFor(doctor))
      .send({ blocked: true })
      .expect(200);
    expect((await inviteFrom(doctor, blocked)).body.error.code).toBe('CONFLICT');

    const { patientId: linked } = await aLinkedPatient(doctor, 'Linked', OTHER_PHONE);
    expect((await inviteFrom(doctor, linked)).body.error.code).toBe('CONFLICT');

    const off = await aPatient(doctor, 'Off');
    await portalOff(doctor);
    expect((await inviteFrom(doctor, off)).body.error.code).toBe('FEATURE_DISABLED');
    expect(await PatientInvite.countDocuments()).toBe(0);
  });

  test('never when a patient is added, even on auto', async () => {
    await setAuto(doctor);
    const spy = smsSpy();

    const patientId = await aPatient(doctor, 'Zainab Hidden');

    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(await PatientInvite.countDocuments({ patientId })).toBe(0);
  });

  test('automatic: after the first approval, once only, and not on a revision or a second prescription', async () => {
    await setAuto(doctor);
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const spy = smsSpy();

    const first = await anApproved(doctor, patientId);
    await waitFor(
      async () => spy.mock.calls.length,
      (count) => count === 1,
    );
    expect(spy.mock.calls[0][0]).toBe(FAMILY_PHONE);
    expect(spy.mock.calls[0][1]).toContain('Dr Ayesha');
    expect((await PatientInvite.findOne({ patientId }))?.autoSentAt).toBeInstanceOf(Date);

    // The code it sent works.
    await tryLink(await signIn(FAMILY_PHONE), 'invite', lastCodeIn(spy.mock.calls[0][1])).expect(201);
    await request(app).delete(`/api/v1/patients/${patientId}/portal/link`).set(headersFor(doctor)).expect(200);
    await aDayPasses(patientId);

    const revision = await request(app)
      .post(`/api/v1/prescriptions/${first.id}/revise`)
      .set(headersFor(doctor, { location: true }))
      .send({ reason: 'Changing the dose' })
      .expect(201);
    await request(app)
      .post(`/api/v1/prescriptions/${revision.body.data.id}/approve`)
      .set(headersFor(doctor, { location: true }))
      .expect(200);
    await anApproved(doctor, patientId);

    await settle();
    expect(invitesIn(spy)).toHaveLength(1);
  });

  test('automatic: even if it were asked again for a first approval, once per record ever', async () => {
    await setAuto(doctor);
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const spy = smsSpy();
    const first = await anApproved(doctor, patientId);
    await waitFor(
      async () => spy.mock.calls.length,
      (count) => count === 1,
    );

    // The only approval is gone, the cooldown has passed, and the next is "first" again.
    await Prescription.updateOne({ _id: first.id }, { $set: { deletedAt: new Date() } });
    await aDayPasses(patientId);
    await anApproved(doctor, patientId);

    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['on manual', async (actor: SignedIn) => setClinic(actor, [{ key: 'portal.invites', value: 'manual' }])],
    [
      'with the portal off',
      async (actor: SignedIn) =>
        setClinic(actor, [
          { key: 'portal.invites', value: 'auto' },
          { key: 'portal.enabled', value: false },
        ]),
    ],
  ])('automatic: nothing %s', async (_name, arrange) => {
    await arrange(doctor);
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const spy = smsSpy();

    await anApproved(doctor, patientId);

    await settle();
    expect(spy).not.toHaveBeenCalled();
    expect(await PatientInvite.countDocuments()).toBe(0);
  });

  test('automatic: nothing with no phone, a blocked record, or an invite from the desk just now', async () => {
    await setAuto(doctor);
    const noPhone = await aPatient(doctor, 'No Phone', null);
    const blocked = await aPatient(doctor, 'Blocked', OTHER_PHONE);
    await request(app)
      .patch(`/api/v1/patients/${blocked}/portal`)
      .set(headersFor(doctor))
      .send({ blocked: true })
      .expect(200);
    const invited = await aPatient(doctor, 'Invited');
    await anInvite(doctor, invited);
    const spy = smsSpy();
    spy.mockClear();

    await anApproved(doctor, noPhone);
    await anApproved(doctor, blocked);
    await anApproved(doctor, invited);

    await settle();
    expect(spy).not.toHaveBeenCalled();
  });

  test('a failed SMS fails neither an approval nor a manual invite', async () => {
    await setAuto(doctor);
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const spy = smsSpy().mockRejectedValue(new Error('gateway down'));

    const signed = await anApproved(doctor, patientId);
    expect(signed.status).toBe('approved');
    await waitFor(
      async () => spy.mock.calls.length,
      (count) => count === 1,
    );

    const other = await aPatient(doctor, 'Someone Else', OTHER_PHONE);
    await inviteFrom(doctor, other).expect(200);
  });

  test('a phone change or a block voids an invite that has gone out', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    const code = await anInvite(doctor, patientId);
    expect((await portalState(doctor, patientId)).status).toBe('invited');

    await request(app)
      .patch(`/api/v1/patients/${patientId}`)
      .set(headersFor(doctor))
      .send({ phone: OTHER_PHONE })
      .expect(200);

    expect((await portalState(doctor, patientId)).status).toBe('none');
    expectFailed(await tryLink(await signIn(OTHER_PHONE), 'invite', code));

    const blocked = await aPatient(doctor, 'Blocked', '+923001110003');
    const blockedCode = await anInvite(doctor, blocked);
    await request(app)
      .patch(`/api/v1/patients/${blocked}/portal`)
      .set(headersFor(doctor))
      .send({ blocked: true })
      .expect(200);
    await request(app)
      .patch(`/api/v1/patients/${blocked}/portal`)
      .set(headersFor(doctor))
      .send({ blocked: false })
      .expect(200);

    expect((await portalState(doctor, blocked)).status).toBe('none');
    expectFailed(await tryLink(await signIn('+923001110003'), 'invite', blockedCode));
  });
});

describe('Uploading a report', () => {
  let doctor: SignedIn;

  beforeEach(async () => {
    doctor = await aPortalClinic('+923005550001');
  });

  const uploadTicket = async (person: SignedIn, linkId: string, body: object = { contentType: 'image/jpeg', size: 1000 }) =>
    request(app).post(`/api/v1/portal/links/${linkId}/uploads`).set(bearer(person)).send(body);

  const fileWith = (person: SignedIn, linkId: string, pageKeys: string[]) =>
    request(app)
      .post(`/api/v1/portal/links/${linkId}/reports`)
      .set(bearer(person))
      .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys });

  test("a patient's report reaches the inbox unreviewed, with source: 'patient'", async () => {
    const { person, linkId, patientId } = await aLinkedPatient(doctor);
    const ticket = await uploadTicket(person, linkId);
    expect(ticket.status).toBe(201);
    expect(ticket.body.data.uploadUrl).toContain('sig=');

    const filed = await fileWith(person, linkId, [ticket.body.data.fileKey]).expect(201);
    expect(filed.body.data).toMatchObject({ source: 'patient', reviewed: false, pages: 1 });

    const row = await Report.findById(filed.body.data.id);
    expect(String(row?.uploadedBy)).toBe(person.userId);
    expect(String(row?.createdBy)).toBe(person.userId);
    expect(row?.reviewedAt).toBeNull();
    expect(await AuditLog.countDocuments({ action: 'report.create', role: 'patient', entityId: row?._id })).toBe(1);

    // On staff's side it is a report like any other, and says where it came from.
    const inbox = await request(app).get(`/api/v1/patients/${patientId}/reports`).set(headersFor(doctor)).expect(200);
    expect(inbox.body.data[0]).toMatchObject({
      id: filed.body.data.id,
      source: 'patient',
      uploadedBy: person.userId,
      reviewedAt: null,
    });
    const list = await request(app).get('/api/v1/patients?newReports=true').set(headersFor(doctor)).expect(200);
    expect(list.body.data.map((patient: { id: string }) => patient.id)).toContain(patientId);

    await request(app).post(`/api/v1/reports/${filed.body.data.id}/review`).set(headersFor(doctor)).expect(200);
    const seen = await read(person, `${linkId}/reports/${filed.body.data.id}`).expect(200);
    expect(seen.body.data.reviewed).toBe(true);
  });

  test('a report staff filed reads as source: clinic', async () => {
    const { patientId } = await aLinkedPatient(doctor);
    const ticket = await request(app)
      .post('/api/v1/reports/uploads')
      .set(headersFor(doctor))
      .send({ contentType: 'image/jpeg', size: 10 })
      .expect(201);
    const filed = await request(app)
      .post(`/api/v1/patients/${patientId}/reports`)
      .set(headersFor(doctor))
      .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: [ticket.body.data.fileKey] })
      .expect(201);
    expect(filed.body.data.source).toBe('clinic');
  });

  test('a page key from another link, staff, or a crafted path is refused', async () => {
    const { person, linkId } = await aLinkedPatient(doctor);
    const { person: otherPerson, linkId: otherLink } = await aLinkedPatient(doctor, 'Someone Else', OTHER_PHONE);
    const theirs = (await uploadTicket(otherPerson, otherLink)).body.data.fileKey;
    const staffs = (
      await request(app)
        .post('/api/v1/reports/uploads')
        .set(headersFor(doctor))
        .send({ contentType: 'image/jpeg', size: 10 })
        .expect(201)
    ).body.data.fileKey;
    const prefix = `${doctor.practiceId}/reports/portal/${linkId}/`;

    const refused = [
      theirs,
      staffs,
      `${prefix}../${otherLink}/${theirs.split('/').pop()}`,
      `${prefix}../../pages/${staffs.split('/').pop()}`,
      `${prefix}${'a'.repeat(24)}.exe`,
      'anything/at/all.jpg',
    ];

    const answers = await Promise.all(refused.map((key) => fileWith(person, linkId, [key])));
    answers.forEach((answer, at) => {
      expect({ key: refused[at], code: answer.body.error?.code }).toEqual({ key: refused[at], code: 'VALIDATION_ERROR' });
    });
    expect(await Report.countDocuments()).toBe(0);
  });

  test("REPORT_UPLOAD's limits hold, and a patient can't name a visit", async () => {
    const { person, linkId } = await aLinkedPatient(doctor);

    expect((await uploadTicket(person, linkId, { contentType: 'image/jpeg', size: 11 * 1024 * 1024 })).status).toBe(400);
    expect((await uploadTicket(person, linkId, { contentType: 'text/html', size: 10 })).status).toBe(400);

    const ticket = await uploadTicket(person, linkId);
    await fileWith(person, linkId, []).expect(400);
    await fileWith(person, linkId, Array(11).fill(ticket.body.data.fileKey)).expect(400);

    const filed = await request(app)
      .post(`/api/v1/portal/links/${linkId}/reports`)
      .set(bearer(person))
      .send({
        type: 'lab',
        testName: 'CBC',
        testDate: '2026-10-01',
        pageKeys: [ticket.body.data.fileKey],
        visitId: doctor.locationId,
      })
      .expect(201);
    expect((await Report.findById(filed.body.data.id))?.visitId).toBeNull();
  });
});

describe("The clinic's controls", () => {
  let doctor: SignedIn;

  beforeEach(async () => {
    doctor = await aPortalClinic('+923005550001');
  });

  test('the status follows the record, and never says which account holds the link', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    expect(await portalState(doctor, patientId)).toEqual({
      status: 'none',
      invitedAt: null,
      linkedAt: null,
      blocked: false,
      available: true,
    });

    const code = await anInvite(doctor, patientId);
    const invited = await portalState(doctor, patientId);
    expect(invited.status).toBe('invited');
    expect(invited.invitedAt).toEqual(expect.any(String));

    const person = await signIn(FAMILY_PHONE);
    await linkOf(person, 'invite', code);
    const linked = await portalState(doctor, patientId);
    expect(linked.status).toBe('linked');
    expect(linked.linkedAt).toEqual(expect.any(String));
    expect(JSON.stringify(linked)).not.toContain(person.userId);
    expect(Object.keys(linked).sort()).toEqual(['available', 'blocked', 'invitedAt', 'linkedAt', 'status']);

    await PatientInvite.updateOne({ patientId }, { $set: { usedAt: null, expiresAt: addDays(new Date(), -1) } });
    await request(app).delete(`/api/v1/patients/${patientId}/portal/link`).set(headersFor(doctor)).expect(200);
    expect((await portalState(doctor, patientId)).status).toBe('none');
  });

  test('available says whether the portal is on and the record has a phone', async () => {
    const withPhone = await aPatient(doctor, 'With Phone');
    const without = await aPatient(doctor, 'No Phone', null);

    expect((await portalState(doctor, withPhone)).available).toBe(true);
    expect((await portalState(doctor, without)).available).toBe(false);

    await portalOff(doctor);
    expect((await portalState(doctor, withPhone)).available).toBe(false);
  });

  test("an assistant works with their own locations' patients, and gets NOT_FOUND outside them", async () => {
    const branch = await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'Branch' }).expect(201);
    const pa = await aPa(doctor, '+923005550003', [branch.body.data.id]);
    const elsewhere = await aPatient(doctor, 'Elsewhere');
    const own = await aPatient(pa, 'Own', OTHER_PHONE);

    await Promise.all([
      request(app).get(`/api/v1/patients/${elsewhere}/portal`).set(headersFor(pa)).expect(404),
      request(app).post(`/api/v1/patients/${elsewhere}/portal/invite`).set(headersFor(pa)).expect(404),
      request(app).patch(`/api/v1/patients/${elsewhere}/portal`).set(headersFor(pa)).send({ blocked: true }).expect(404),
      request(app).delete(`/api/v1/patients/${elsewhere}/portal/link`).set(headersFor(pa)).expect(404),
    ]);
    expect((await Patient.findById(elsewhere))?.portalBlocked).toBe(false);

    await request(app).get(`/api/v1/patients/${own}/portal`).set(headersFor(pa)).expect(200);
    await request(app).post(`/api/v1/patients/${own}/portal/invite`).set(headersFor(pa)).expect(200);
    await request(app).patch(`/api/v1/patients/${own}/portal`).set(headersFor(pa)).send({ blocked: true }).expect(200);
    await request(app).delete(`/api/v1/patients/${own}/portal/link`).set(headersFor(pa)).expect(200);
  });

  test('a medicine manager gets FORBIDDEN from all of it', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');
    await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923005550004', name: 'Hina', role: 'medicineManager' })
      .expect(201);
    const manager = await signIn('+923005550004');

    const answers = await Promise.all([
      request(app).get(`/api/v1/patients/${patientId}/portal`).set(headersFor(manager)),
      request(app).post(`/api/v1/patients/${patientId}/portal/invite`).set(headersFor(manager)),
      request(app).patch(`/api/v1/patients/${patientId}/portal`).set(headersFor(manager)).send({ blocked: true }),
      request(app).delete(`/api/v1/patients/${patientId}/portal/link`).set(headersFor(manager)),
    ]);
    answers.forEach((answer) => {
      expect(answer.status).toBe(403);
      expect(answer.body.error.code).toBe('FORBIDDEN');
    });
  });

  test("another clinic's patient is NOT_FOUND", async () => {
    const another = await aPortalClinic('+923005550002', 'Dr Bilal');
    const theirs = await aPatient(another, 'Theirs');

    await request(app).get(`/api/v1/patients/${theirs}/portal`).set(headersFor(doctor)).expect(404);
  });

  test('a block is audited once, and blocking again changes nothing', async () => {
    const patientId = await aPatient(doctor, 'Zainab Hidden');

    await request(app)
      .patch(`/api/v1/patients/${patientId}/portal`)
      .set(headersFor(doctor))
      .send({ blocked: true })
      .expect(200);
    await request(app)
      .patch(`/api/v1/patients/${patientId}/portal`)
      .set(headersFor(doctor))
      .send({ blocked: true })
      .expect(200);

    expect(await AuditLog.countDocuments({ action: 'patient.portal.block', entityId: patientId })).toBe(1);
  });

  test('the settings: a doctor sets them, nobody else, and nobody for themselves', async () => {
    const pa = await aPa(doctor, '+923005550003');

    const settings = await request(app).get('/api/v1/settings').set(headersFor(doctor)).expect(200);
    expect(settings.body.data['portal.enabled']).toMatchObject({ value: true, source: 'organisation' });
    expect(settings.body.data['portal.invites']).toMatchObject({ value: 'manual', source: 'default' });

    await request(app)
      .patch('/api/v1/settings/organisation')
      .set(headersFor(pa))
      .send({ values: [{ key: 'portal.enabled', value: false }] })
      .expect(403);
    await request(app)
      .patch('/api/v1/settings/me')
      .set(headersFor(doctor))
      .send({ values: [{ key: 'portal.enabled', value: false }] })
      .expect(400);
    await request(app)
      .patch('/api/v1/settings/organisation')
      .set(headersFor(doctor))
      .send({ values: [{ key: 'portal.invites', value: 'sometimes' }] })
      .expect(400);
  });

  describe('every change reaches the patients topic', () => {
    let live: Live;

    beforeEach(async () => {
      live = await startLive();
    });

    afterEach(async () => {
      await live.close();
    });

    test('invite, block, removing a link, and the patient making or removing one; never to a medicine manager', async () => {
      const patientId = await aPatient(doctor, 'Zainab Hidden');
      const prescription = await anApproved(doctor, patientId);
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923005550004', name: 'Hina', role: 'medicineManager' })
        .expect(201);
      const manager = await signIn('+923005550004');

      const socket = await openSocket(live.url, doctor, doctor.locationId);
      const managerSocket = await openSocket(live.url, manager, manager.locationId || doctor.locationId);

      const heard = () =>
        socket.inbox.filter(
          (message) => message.type === 'changed' && message.topic === 'patients' && message.id === patientId,
        ).length;
      const next = async (act: () => Promise<unknown>) => {
        const before = heard();
        await act();
        await socket.until(() => heard() > before);
      };

      await next(() => inviteFrom(doctor, patientId).expect(200));
      const person = await signIn(FAMILY_PHONE);
      let linkId = '';
      await next(async () => {
        linkId = await linkOf(person, 'prescription', prescription.verification.code);
      });
      await next(() => request(app).delete(`/api/v1/portal/links/${linkId}`).set(bearer(person)).expect(200));
      await next(async () => {
        linkId = (await tryLink(person, 'prescription', prescription.verification.code).expect(201)).body.data.id;
      });
      await next(() => request(app).delete(`/api/v1/patients/${patientId}/portal/link`).set(headersFor(doctor)).expect(200));
      await next(() =>
        request(app)
          .patch(`/api/v1/patients/${patientId}/portal`)
          .set(headersFor(doctor))
          .send({ blocked: true })
          .expect(200),
      );

      expect(managerSocket.inbox.filter((message) => message.type === 'changed' && message.topic === 'patients')).toEqual(
        [],
      );
      socket.ws.close();
      managerSocket.ws.close();
    });

    test("a patient's upload reaches the reports topic", async () => {
      const { person, linkId } = await aLinkedPatient(doctor);
      const socket = await openSocket(live.url, doctor, doctor.locationId);

      const ticket = await request(app)
        .post(`/api/v1/portal/links/${linkId}/uploads`)
        .set(bearer(person))
        .send({ contentType: 'image/jpeg', size: 10 })
        .expect(201);
      const filed = await request(app)
        .post(`/api/v1/portal/links/${linkId}/reports`)
        .set(bearer(person))
        .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: [ticket.body.data.fileKey] })
        .expect(201);

      await socket.until((inbox) =>
        inbox.some(
          (message) => message.type === 'changed' && message.topic === 'reports' && message.id === filed.body.data.id,
        ),
      );
      socket.ws.close();
    });
  });
});
