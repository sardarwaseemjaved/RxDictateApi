import { randomBytes } from 'crypto';
import express from 'express';
import jsQR from 'jsqr';
import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config/config';
import logger from '../../src/config/logger';
import morgan from '../../src/config/morgan';
import { AuditLog, Prescription } from '../../src/models';
import { prescriptionHtml } from '../../src/services/pdf.service';
import { backfillVerificationCodes } from '../../src/services/verify.service';
import { verifyQrPath, verifyViewSchema } from '../../src/shared/verify.schema';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, headersFor, pause, type SignedIn } from '../fixtures/clinic.fixture';

setupTestDB();

const CODE = /^[A-Za-z0-9_-]{22}$/;

const MEDICINE_KEYS = [
  'durationDays',
  'form',
  'instructionEn',
  'instructionUr',
  'name',
  'pattern',
  'route',
  'strength',
  'timing',
];

/** Everything a prescription can say that the verify page must not. */
const PRIVATE_SECTIONS = [
  { op: 'add', section: 'complaints', value: { text: 'Burning chest' } },
  { op: 'add', section: 'history', value: { text: 'Smoker for years' } },
  { op: 'add', section: 'examination', value: { text: 'Epigastric tenderness' } },
  { op: 'add', section: 'diagnosis', value: { text: 'Gastritis' } },
  { op: 'add', section: 'labs', value: { text: 'H. pylori stool test' } },
  { op: 'add', section: 'dietEat', value: { text: 'Yoghurt' } },
  { op: 'add', section: 'dietAvoid', value: { text: 'Chillies' } },
  { op: 'add', section: 'advice', value: { text: 'Sleep propped up' } },
];

const OMEPRAZOLE = {
  op: 'add',
  section: 'medicines',
  value: {
    name: 'Omeprazole',
    strength: '20mg',
    form: 'cap',
    pattern: { m: 1, a: 0, n: 0 },
    timing: 'before_meal',
    durationDays: 14,
  },
};

const aPatient = async (doctor: SignedIn, name = 'Muhammad Ali Khan', phone = '+923451234567') =>
  (
    await request(app)
      .post('/api/v1/patients')
      .set(headersFor(doctor))
      .send({ name, phone, age: 52, sex: 'male', allergies: ['Penicillin'], conditions: ['Diabetes'] })
      .expect(201)
  ).body.data;

/** A draft with a medicine and every other section filled in, approved. */
const approve = async (doctor: SignedIn, patientId: string) => {
  const headers = headersFor(doctor, { location: true });
  const draft = await aDraft(doctor, patientId);
  await request(app)
    .patch(`/api/v1/prescriptions/${draft.id}`)
    .set(headers)
    .send({ ops: [OMEPRAZOLE, ...PRIVATE_SECTIONS] })
    .expect(200);
  return (await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200)).body.data;
};

const revise = async (doctor: SignedIn, id: string) =>
  (
    await request(app)
      .post(`/api/v1/prescriptions/${id}/revise`)
      .set(headersFor(doctor, { location: true }))
      .send({ reason: 'longer course' })
      .expect(201)
  ).body.data;

const approveDraft = async (doctor: SignedIn, id: string) =>
  (
    await request(app)
      .post(`/api/v1/prescriptions/${id}/approve`)
      .set(headersFor(doctor, { location: true }))
      .expect(200)
  ).body.data;

/** Exactly what a pharmacist's phone sends: nothing but the URL. */
const verify = (code: string) => request(app).get(`/api/v1/verify/${code}`);

const aStrangerCode = () => randomBytes(16).toString('base64url');

/**
 * Read a QR code the way a phone camera would: draw the SVG's modules as
 * pixels, with a quiet zone around them because the printout supplies its own,
 * and decode them.
 */
const decodeQr = (svg: string): string | undefined => {
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  const dark = new Set<string>();
  const runs = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  let run = runs.exec(svg);
  while (run) {
    const [, x, y, length] = run.map(Number);
    for (let i = 0; i < length; i += 1) {
      dark.add(`${x + i},${y}`);
    }
    run = runs.exec(svg);
  }

  const scale = 8;
  const quiet = 4;
  const side = (size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4);
  for (let py = 0; py < side; py += 1) {
    for (let px = 0; px < side; px += 1) {
      const isDark = dark.has(`${Math.floor(px / scale) - quiet},${Math.floor(py / scale) - quiet}`);
      pixels.fill(isDark ? 0 : 255, (py * side + px) * 4, (py * side + px) * 4 + 3);
      pixels[(py * side + px) * 4 + 3] = 255;
    }
  }
  return jsQR(pixels, side, side)?.data;
};

const textOf = (response: request.Response): string =>
  response.text ?? (Buffer.isBuffer(response.body) ? response.body.toString('utf8') : '');

describe('Verifying a printout', () => {
  describe('making codes', () => {
    test('approval makes a code and the link the QR holds; a draft has none', async () => {
      const { doctor, patientId } = await aClinic('+923008800101', 'Dr Verify');
      const patient = await aPatient(doctor);

      const draft = await aDraft(doctor, patientId);
      expect(draft.verification).toBeNull();

      const approved = await approve(doctor, patient.id);
      expect(approved.verification.code).toMatch(CODE);
      expect(approved.verification.url).toBe(`${config.verify.baseUrl}/${approved.verification.code}`);

      const read = await request(app)
        .get(`/api/v1/prescriptions/${approved.id}`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      expect(read.body.data.verification).toEqual(approved.verification);
    });

    test('codes are unique, and the database refuses a second copy of one', async () => {
      const { doctor } = await aClinic('+923008800102', 'Dr Verify');
      const approved = [];
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const patient = await aPatient(doctor, `Patient Number${i}`, `+92345123456${i}`);
        // eslint-disable-next-line no-await-in-loop
        approved.push(await approve(doctor, patient.id));
      }
      const codes = approved.map((prescription) => prescription.verification.code);
      expect(new Set(codes).size).toBe(3);

      await expect(
        Prescription.updateOne({ _id: approved[1].id }, { $set: { verificationCode: codes[0] } }),
      ).rejects.toMatchObject({ code: 11000 });
    });

    test('a superseded prescription keeps its code, and its revision gets its own', async () => {
      const { doctor } = await aClinic('+923008800103', 'Dr Verify');
      const first = await approve(doctor, (await aPatient(doctor)).id);
      const second = await approveDraft(doctor, (await revise(doctor, first.id)).id);

      const old = await request(app)
        .get(`/api/v1/prescriptions/${first.id}`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      expect(old.body.data.status).toBe('superseded');
      expect(old.body.data.verification).toEqual(first.verification);
      expect(second.verification.code).not.toBe(first.verification.code);
    });

    test('the backfill gives old approved and superseded prescriptions a code each, and nothing else', async () => {
      const { doctor, patientId } = await aClinic('+923008800104', 'Dr Verify');
      const first = await approve(doctor, (await aPatient(doctor)).id);
      const second = await approveDraft(doctor, (await revise(doctor, first.id)).id);
      const cancelled = await aDraft(doctor, patientId);
      await request(app)
        .post(`/api/v1/prescriptions/${cancelled.id}/cancel`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      const draft = await aDraft(doctor, patientId);

      // As every row looked before codes existed.
      await Prescription.collection.updateMany({}, { $unset: { verificationCode: '' } });

      expect(await backfillVerificationCodes()).toBe(2);
      const codeOf = async (id: string) => (await Prescription.findById(id))!.verificationCode;
      const [v1, v2] = [await codeOf(first.id), await codeOf(second.id)];
      expect(v1).toMatch(CODE);
      expect(v2).toMatch(CODE);
      expect(v1).not.toBe(v2);
      expect(await codeOf(cancelled.id)).toBeNull();
      expect(await codeOf(draft.id)).toBeNull();

      expect(await backfillVerificationCodes()).toBe(0);
      await verify(v1!).expect(200);
    });
  });

  describe('GET /verify/:code', () => {
    test('an approved prescription answers valid, with no sign-in or clinic header at all', async () => {
      const { doctor } = await aClinic('+923008800201', 'Dr Verify');
      const approved = await approve(doctor, (await aPatient(doctor)).id);
      const snapshot = approved.letterheadSnapshot;

      const response = await verify(approved.verification.code).expect(200);
      const medicine = approved.sections.medicines[0];

      expect(verifyViewSchema.safeParse(response.body.data).success).toBe(true);
      expect(response.body.data).toEqual({
        status: 'valid',
        number: approved.number,
        approvedAt: approved.approvedAt,
        doctor: {
          name: snapshot.doctorName,
          qualifications: snapshot.qualifications,
          speciality: snapshot.speciality,
          pmdcNo: snapshot.pmdcNo,
        },
        clinic: { name: snapshot.locationName, address: snapshot.address },
        patient: { initials: 'M. K.', age: 52, sex: 'male' },
        medicines: [Object.fromEntries(MEDICINE_KEYS.map((key) => [key, medicine[key]]))],
        replacedBy: null,
      });
      expect(response.body.data.medicines[0]).toMatchObject({ name: 'Omeprazole', durationDays: 14 });
    });

    test('the answer carries nothing that identifies the patient or describes their illness', async () => {
      const { doctor } = await aClinic('+923008800202', 'Dr Verify');
      const patient = await aPatient(doctor);
      const approved = await approve(doctor, patient.id);

      const { data } = (await verify(approved.verification.code).expect(200)).body;

      expect(Object.keys(data).sort()).toEqual([
        'approvedAt',
        'clinic',
        'doctor',
        'medicines',
        'number',
        'patient',
        'replacedBy',
        'status',
      ]);
      expect(Object.keys(data.patient).sort()).toEqual(['age', 'initials', 'sex']);
      expect(Object.keys(data.doctor).sort()).toEqual(['name', 'pmdcNo', 'qualifications', 'speciality']);
      expect(Object.keys(data.clinic).sort()).toEqual(['address', 'name']);
      data.medicines.forEach((line: Record<string, unknown>) => expect(Object.keys(line).sort()).toEqual(MEDICINE_KEYS));

      const wire = JSON.stringify(data);
      [
        'Muhammad',
        'Khan',
        patient.phone,
        patient.phone.slice(3),
        patient.mrNo,
        patient.id,
        approved.id,
        approved.patientId,
        doctor.practiceId,
        'Penicillin',
        'Diabetes',
        ...PRIVATE_SECTIONS.map((op) => op.value.text),
      ].forEach((secret) => expect(wire).not.toContain(secret));
    });

    test('a superseded prescription answers replaced, naming the version in its place, with no medicines', async () => {
      const { doctor } = await aClinic('+923008800203', 'Dr Verify');
      const first = await approve(doctor, (await aPatient(doctor)).id);

      // A revision still being written leaves the patient's page valid.
      const revision = await revise(doctor, first.id);
      expect((await verify(first.verification.code).expect(200)).body.data.status).toBe('valid');

      const second = await approveDraft(doctor, revision.id);
      const replaced = (await verify(first.verification.code).expect(200)).body.data;
      expect(replaced).toMatchObject({
        status: 'replaced',
        number: first.number,
        medicines: [],
        replacedBy: { number: second.number, approvedAt: second.approvedAt },
      });
      expect((await verify(second.verification.code).expect(200)).body.data).toMatchObject({
        status: 'valid',
        replacedBy: null,
      });

      // Revised again: the first page points at the one that stands now.
      const third = await approveDraft(doctor, (await revise(doctor, second.id)).id);
      expect((await verify(first.verification.code).expect(200)).body.data.replacedBy).toEqual({
        number: third.number,
        approvedAt: third.approvedAt,
      });
    });

    test('an unknown, malformed, draft or cancelled code all get the same NOT_FOUND', async () => {
      const { doctor, patientId } = await aClinic('+923008800204', 'Dr Verify');
      const headers = headersFor(doctor, { location: true });

      // Neither ever has a code; give them one, as if the data had gone wrong.
      const cancelled = await aDraft(doctor, patientId);
      await request(app).post(`/api/v1/prescriptions/${cancelled.id}/cancel`).set(headers).expect(200);
      const draft = await aDraft(doctor, patientId);
      const [draftCode, cancelledCode] = [aStrangerCode(), aStrangerCode()];
      await Prescription.updateOne({ _id: draft.id }, { $set: { verificationCode: draftCode } });
      await Prescription.updateOne({ _id: cancelled.id }, { $set: { verificationCode: cancelledCode } });

      const unknown = await verify(aStrangerCode());
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ error: { code: 'NOT_FOUND', message: 'No prescription matches this code.' } });

      const others = await Promise.all(
        [`${aStrangerCode()}x`, 'short', 'has%20spaces%20in%20it%2C%20not%20ok', draftCode, cancelledCode].map(verify),
      );
      others.forEach((response) => {
        expect(response.status).toBe(404);
        expect(response.body).toEqual(unknown.body);
      });
    });

    test('a read writes no audit row', async () => {
      const { doctor } = await aClinic('+923008800205', 'Dr Verify');
      const approved = await approve(doctor, (await aPatient(doctor)).id);
      const before = await AuditLog.countDocuments();

      await verify(approved.verification.code).expect(200);
      await request(app)
        .get(`/api/v1${verifyQrPath(approved.verification.code)}`)
        .expect(200);
      await verify(aStrangerCode()).expect(404);

      expect(await AuditLog.countDocuments()).toBe(before);
    });
  });

  describe('GET /verify/:code/qr.svg', () => {
    test('is an SVG of the link, cached for a year by anyone', async () => {
      const { doctor } = await aClinic('+923008800301', 'Dr Verify');
      const approved = await approve(doctor, (await aPatient(doctor)).id);

      const response = await request(app)
        .get(`/api/v1${verifyQrPath(approved.verification.code)}`)
        .expect(200);

      expect(response.headers['content-type']).toMatch(/^image\/svg\+xml/);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
      const svg = textOf(response);
      expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(decodeQr(svg)).toBe(approved.verification.url);
    });

    test('an unknown code gets a 404', async () => {
      const response = await request(app)
        .get(`/api/v1${verifyQrPath(aStrangerCode())}`)
        .expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe("the server's own printout", () => {
    test('puts the QR beside the Rx ID once approved; the draft preview has neither', async () => {
      const { doctor, patientId } = await aClinic('+923008800401', 'Dr Verify');
      const approved = await approve(doctor, (await aPatient(doctor)).id);

      const html = prescriptionHtml((await Prescription.findById(approved.id))!, 'Muhammad Ali Khan', 52);
      const footer = /<span class="rx-id"><span class="qr">(<svg[^]*?<\/svg>)<\/span><span>([^<]*)<\/span>/.exec(html);
      expect(footer).not.toBeNull();
      expect(decodeQr(footer![1])).toBe(approved.verification.url);
      expect(footer![2]).toContain(approved.number);

      const draft = await aDraft(doctor, patientId);
      const preview = prescriptionHtml((await Prescription.findById(draft.id))!, 'Test Patient', 40, {
        draft: true,
        letterhead: approved.letterheadSnapshot,
      });
      expect(preview).not.toContain('<svg');
      expect(preview).not.toContain('class="qr"');
      expect(preview).not.toContain('RX-');
    });
  });

  describe('the request log', () => {
    test('keeps only the start of a code, in the path and in an error message', async () => {
      const { doctor } = await aClinic('+923008800501', 'Dr Verify');
      const approved = await approve(doctor, (await aPatient(doctor)).id);
      const { code } = approved.verification;

      // The access log as production mounts it; the suite runs without one.
      const logged = express();
      logged.use(morgan.successHandler);
      logged.use(morgan.errorHandler);
      logged.use(app);
      const info = jest.spyOn(logger, 'info').mockReturnValue(logger);
      const error = jest.spyOn(logger, 'error').mockReturnValue(logger);

      await request(logged).get(`/api/v1/verify/${code}`).expect(200);
      await request(logged).get(`/api/v1/verify/${code}/qr.svg`).expect(200);
      // An unknown route's message repeats the path.
      await request(logged).get(`/api/v1/verify/${code}/nothing-here`).expect(404);
      await pause(50);

      const lines = [...info.mock.calls, ...error.mock.calls].map(([line]) => String(line));
      const verifyLines = lines.filter((line) => line.includes('/verify/'));
      expect(verifyLines).toHaveLength(3);
      verifyLines.forEach((line) => {
        expect(line).not.toContain(code);
        expect(line).toContain(`/api/v1/verify/${code.slice(0, 4)}…`);
      });
    });
  });
});
