import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, headersFor } from '../fixtures/clinic.fixture';
import { AuditLog, Prescription } from '../../src/models';

setupTestDB();

const addComplaint = (text: string) => ({
  ops: [{ op: 'add', section: 'complaints', value: { text } }],
});

const addMedicine = (name: string) => ({
  ops: [
    {
      op: 'add',
      section: 'medicines',
      value: { name, strength: '500mg', pattern: { m: 1, a: 0, n: 1 }, timing: 'after_meal', durationDays: 5 },
    },
  ],
});

describe('Prescriptions', () => {
  describe('a draft is editable through ops', () => {
    test('add, update and remove reach the right section', async () => {
      const { doctor, patientId } = await aClinic('+923002220001');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      const added = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send(addComplaint('Fever for three days'))
        .expect(200);
      expect(added.body.data.sections.complaints).toHaveLength(1);

      const itemId = added.body.data.sections.complaints[0].id;

      const updated = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({ ops: [{ op: 'update', section: 'complaints', itemId, value: { text: 'Fever for five days' } }] })
        .expect(200);
      expect(updated.body.data.sections.complaints[0].text).toBe('Fever for five days');
      expect(updated.body.data.sections.complaints[0].id).toBe(itemId);

      const removed = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({ ops: [{ op: 'remove', section: 'complaints', itemId }] })
        .expect(200);
      expect(removed.body.data.sections.complaints).toHaveLength(0);

      // Three doctor corrections, which is what measures AI accuracy later.
      expect(removed.body.data.editCount).toBe(3);
    });

    test('an op naming an item that is not there is refused, and nothing is applied', async () => {
      const { doctor, patientId } = await aClinic('+923002220002');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      const response = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({
          ops: [
            { op: 'add', section: 'advice', value: { text: 'Rest' } },
            { op: 'update', section: 'advice', itemId: 'nope', value: { text: 'Drink water' } },
          ],
        })
        .expect(400);
      expect(response.body.error.code).toBe('OP_INVALID');

      // The valid op in the same batch was not applied either.
      const after = await request(app).get(`/api/v1/prescriptions/${draft.id}`).set(headers).expect(200);
      expect(after.body.data.sections.advice).toHaveLength(0);
    });

    test('followUp can only be updated', async () => {
      const { doctor, patientId } = await aClinic('+923002220003');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      const refused = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({ ops: [{ op: 'add', section: 'followUp', value: { inDays: 7 } }] })
        .expect(400);
      expect(refused.body.error.code).toBe('OP_INVALID');

      const accepted = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({ ops: [{ op: 'update', section: 'followUp', value: { inDays: 7, note: 'if no better' } }] })
        .expect(200);
      expect(accepted.body.data.sections.followUp).toMatchObject({ inDays: 7, note: 'if no better' });
    });
  });

  describe('approval', () => {
    test('mints a number, freezes the letterhead, and makes the document immutable', async () => {
      const { doctor, patientId } = await aClinic('+923002220004', 'Dr Ayesha Khan');
      const headers = headersFor(doctor, { location: true });

      await request(app)
        .patch(`/api/v1/locations/${doctor.locationId}`)
        .set(headersFor(doctor))
        .send({ name: 'Shifa Clinic', address: '12 Jail Road, Lahore', phone: '042-111-2222' })
        .expect(200);
      await request(app)
        .patch('/api/v1/practice')
        .set(headersFor(doctor))
        .send({ pmdcNo: '12345-P', qualifications: ['MBBS', 'FCPS'] })
        .expect(200);

      const draft = await aDraft(doctor, patientId);
      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Panadol')).expect(200);

      const approved = await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

      expect(approved.body.data.status).toBe('approved');
      expect(approved.body.data.number).toMatch(/^RX-\d{4}-000001$/);
      expect(approved.body.data.letterheadSnapshot).toMatchObject({
        locationName: 'Shifa Clinic',
        address: '12 Jail Road, Lahore',
        phone: '042-111-2222',
        doctorName: 'Dr Ayesha Khan',
        pmdcNo: '12345-P',
        qualifications: ['MBBS', 'FCPS'],
      });

      /**
       * Rule 4: changing the location afterwards must not change a page that has
       * already been printed.
       */
      await request(app)
        .patch(`/api/v1/locations/${doctor.locationId}`)
        .set(headersFor(doctor))
        .send({ name: 'Moved Clinic', address: 'Somewhere else entirely' })
        .expect(200);

      const reread = await request(app).get(`/api/v1/prescriptions/${draft.id}`).set(headers).expect(200);
      expect(reread.body.data.letterheadSnapshot.locationName).toBe('Shifa Clinic');
      expect(reread.body.data.letterheadSnapshot.address).toBe('12 Jail Road, Lahore');
    });

    test('an approved prescription cannot be edited', async () => {
      const { doctor, patientId } = await aClinic('+923002220005');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Augmentin')).expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

      const edit = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send(addComplaint('Trying to sneak a line in'))
        .expect(409);
      expect(edit.body.error.code).toBe('RX_LOCKED');

      const reapprove = await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(409);
      expect(reapprove.body.error.code).toBe('RX_LOCKED');

      const stored = await Prescription.findById(draft.id);
      expect(stored?.sections.complaints).toHaveLength(0);
      expect(stored?.sections.medicines).toHaveLength(1);
    });

    test('an empty prescription is not approvable', async () => {
      const { doctor, patientId } = await aClinic('+923002220006');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      const response = await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('numbers come from an atomic counter, so concurrent approvals never collide', async () => {
      const { doctor, patientId } = await aClinic('+923002220007');
      const headers = headersFor(doctor, { location: true });

      const drafts = await Promise.all([1, 2, 3, 4, 5].map(() => aDraft(doctor, patientId)));
      await Promise.all(
        drafts.map((draft) =>
          request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Brufen')).expect(200),
        ),
      );

      const approvals = await Promise.all(
        drafts.map((draft) => request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers)),
      );
      approvals.forEach((response) => expect(response.status).toBe(200));

      const numbers = approvals.map((response) => response.body.data.number as string);
      expect(new Set(numbers).size).toBe(5);
    });
  });

  describe('revision', () => {
    /** Rule 3, end to end. */
    test('a revise makes version 2 and marks version 1 superseded', async () => {
      const { doctor, patientId } = await aClinic('+923002220008');
      const headers = headersFor(doctor, { location: true });

      const first = await aDraft(doctor, patientId);
      await request(app).patch(`/api/v1/prescriptions/${first.id}`).set(headers).send(addMedicine('Flagyl')).expect(200);
      const approved = await request(app).post(`/api/v1/prescriptions/${first.id}/approve`).set(headers).expect(200);
      const firstNumber = approved.body.data.number as string;

      const revision = await request(app)
        .post(`/api/v1/prescriptions/${first.id}/revise`)
        .set(headers)
        .send({ reason: 'wrong dose' })
        .expect(201);

      expect(revision.body.data.version).toBe(2);
      expect(revision.body.data.previousVersionId).toBe(first.id);
      expect(revision.body.data.status).toBe('draft');
      // A new version earns its own number when it is approved.
      expect(revision.body.data.number).toBeNull();
      // The sections are carried over so the doctor edits rather than retypes.
      expect(revision.body.data.sections.medicines).toHaveLength(1);

      const previous = await request(app).get(`/api/v1/prescriptions/${first.id}`).set(headers).expect(200);
      expect(previous.body.data.status).toBe('superseded');
      expect(previous.body.data.number).toBe(firstNumber);
      expect(previous.body.data.version).toBe(1);

      // Version 2 is a draft, so it edits; version 1 does not, in either direction.
      await request(app)
        .patch(`/api/v1/prescriptions/${revision.body.data.id}`)
        .set(headers)
        .send(addComplaint('Still unwell'))
        .expect(200);

      const edit = await request(app)
        .patch(`/api/v1/prescriptions/${first.id}`)
        .set(headers)
        .send(addComplaint('no'))
        .expect(409);
      expect(edit.body.error.code).toBe('RX_NOT_DRAFT');

      const again = await request(app).post(`/api/v1/prescriptions/${first.id}/revise`).set(headers).send({}).expect(409);
      expect(again.body.error.code).toBe('RX_ALREADY_SUPERSEDED');

      const approvedSecond = await request(app)
        .post(`/api/v1/prescriptions/${revision.body.data.id}/approve`)
        .set(headers)
        .expect(200);
      expect(approvedSecond.body.data.number).not.toBe(firstNumber);
    });

    test('a draft cannot be revised; it is edited', async () => {
      const { doctor, patientId } = await aClinic('+923002220009');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      const response = await request(app).post(`/api/v1/prescriptions/${draft.id}/revise`).set(headers).send({}).expect(409);
      expect(response.body.error.code).toBe('RX_NOT_APPROVED');
    });
  });

  describe('printing', () => {
    test('a draft cannot be printed and an approved one gives a signed url', async () => {
      const { doctor, patientId } = await aClinic('+923002220010');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      const early = await request(app).get(`/api/v1/prescriptions/${draft.id}/pdf`).set(headers).expect(409);
      expect(early.body.error.code).toBe('RX_NOT_APPROVED');

      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Calpol')).expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

      const print = await request(app).get(`/api/v1/prescriptions/${draft.id}/pdf`).set(headers).expect(200);
      expect(print.body.data.url).toBeTruthy();
      expect(new Date(print.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('audit', () => {
    test('every write is recorded, append-only, under the practice', async () => {
      const { doctor, patientId } = await aClinic('+923002220011');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Zithromax')).expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/revise`).set(headers).send({}).expect(201);

      const entries = await AuditLog.find({ practiceId: doctor.practiceId }).sort({ at: 1 });
      const actions = entries.map((entry) => entry.action);

      expect(actions).toEqual(
        expect.arrayContaining([
          'practice.create',
          'location.create',
          'member.add',
          'patient.create',
          'prescription.create',
          'prescription.update',
          'prescription.approve',
          'prescription.revise',
          'prescription.supersede',
        ]),
      );
      entries.forEach((entry) => {
        expect(String(entry.practiceId)).toBe(doctor.practiceId);
        expect(String(entry.actorId)).toBe(doctor.userId);
      });
    });
  });
});
