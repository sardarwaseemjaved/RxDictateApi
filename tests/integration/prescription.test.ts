import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, aPa, headersFor } from '../fixtures/clinic.fixture';
import { AuditLog, Prescription } from '../../src/models';
import { doseInstruction } from '../../src/shared/dose';

/**
 * Follow a signed URL the API handed out, the way the app would.
 *
 * The local storage driver serves its files over HTTP through the API itself,
 * so this goes through the real route - signature check included - rather than
 * reading the file off disk behind its back.
 */
const fetchSigned = async (url: string) => {
  const parsed = new URL(url);
  const response = await request(app).get(`${parsed.pathname}${parsed.search}`);
  return { status: response.status, body: response.text ?? '', contentType: response.headers['content-type'] ?? '' };
};

const readPreview = async (url: string): Promise<string> => {
  const { status, body } = await fetchSigned(url);
  expect(status).toBe(200);
  return body;
};

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
    /**
     * Version 1 stays valid while version 2 is being written. Retiring it the
     * moment a revision opened meant a doctor who was called away left the
     * patient with no valid prescription at all.
     */
    test('a revise opens version 2 and leaves version 1 approved', async () => {
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

      // What the patient is holding is still valid, and says so.
      const previous = await request(app).get(`/api/v1/prescriptions/${first.id}`).set(headers).expect(200);
      expect(previous.body.data.status).toBe('approved');
      expect(previous.body.data.number).toBe(firstNumber);
      expect(previous.body.data.version).toBe(1);
      expect(previous.body.data.revisionId).toBe(revision.body.data.id);

      // It still cannot be edited, and cannot be revised a second time.
      const edit = await request(app)
        .patch(`/api/v1/prescriptions/${first.id}`)
        .set(headers)
        .send(addComplaint('no'))
        .expect(409);
      expect(edit.body.error.code).toBe('RX_LOCKED');

      const again = await request(app).post(`/api/v1/prescriptions/${first.id}/revise`).set(headers).send({}).expect(409);
      expect(again.body.error.code).toBe('CONFLICT');
      expect(again.body.error.details.revisionId).toBe(revision.body.data.id);

      // Signing version 2 is what retires version 1.
      await request(app)
        .patch(`/api/v1/prescriptions/${revision.body.data.id}`)
        .set(headers)
        .send(addComplaint('Still unwell'))
        .expect(200);
      const approvedSecond = await request(app)
        .post(`/api/v1/prescriptions/${revision.body.data.id}/approve`)
        .set(headers)
        .expect(200);
      expect(approvedSecond.body.data.number).not.toBe(firstNumber);

      const retired = await request(app).get(`/api/v1/prescriptions/${first.id}`).set(headers).expect(200);
      expect(retired.body.data.status).toBe('superseded');
      expect(retired.body.data.number).toBe(firstNumber);

      // And now it can be neither edited nor revised again.
      const stale = await request(app).post(`/api/v1/prescriptions/${first.id}/revise`).set(headers).send({}).expect(409);
      expect(stale.body.error.code).toBe('RX_ALREADY_SUPERSEDED');
    });

    test('two revise taps at once open one revision', async () => {
      const { doctor, patientId } = await aClinic('+923002220060');
      const headers = headersFor(doctor, { location: true });
      const first = await aDraft(doctor, patientId);
      await request(app).patch(`/api/v1/prescriptions/${first.id}`).set(headers).send(addMedicine('Flagyl')).expect(200);
      await request(app).post(`/api/v1/prescriptions/${first.id}/approve`).set(headers).expect(200);

      const [a, b] = await Promise.all([
        request(app).post(`/api/v1/prescriptions/${first.id}/revise`).set(headers).send({}),
        request(app).post(`/api/v1/prescriptions/${first.id}/revise`).set(headers).send({}),
      ]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(await Prescription.countDocuments({ previousVersionId: first.id })).toBe(1);
    });

    test('abandoning a revision leaves version 1 exactly as the patient has it', async () => {
      const { doctor, patientId } = await aClinic('+923002220061');
      const headers = headersFor(doctor, { location: true });
      const first = await aDraft(doctor, patientId);
      await request(app).patch(`/api/v1/prescriptions/${first.id}`).set(headers).send(addMedicine('Flagyl')).expect(200);
      const approved = await request(app).post(`/api/v1/prescriptions/${first.id}/approve`).set(headers).expect(200);

      const revision = await request(app).post(`/api/v1/prescriptions/${first.id}/revise`).set(headers).send({}).expect(201);
      const cancelled = await request(app)
        .post(`/api/v1/prescriptions/${revision.body.data.id}/cancel`)
        .set(headers)
        .expect(200);
      expect(cancelled.body.data.status).toBe('cancelled');

      const previous = await request(app).get(`/api/v1/prescriptions/${first.id}`).set(headers).expect(200);
      expect(previous.body.data.status).toBe('approved');
      expect(previous.body.data.number).toBe(approved.body.data.number);
      // No revision is open any more, so the doctor can start another.
      expect(previous.body.data.revisionId).toBeNull();

      await request(app).post(`/api/v1/prescriptions/${first.id}/revise`).set(headers).send({}).expect(201);
    });

    test('an approved prescription cannot be cancelled, only revised', async () => {
      const { doctor, patientId } = await aClinic('+923002220062');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);
      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Flagyl')).expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

      const response = await request(app).post(`/api/v1/prescriptions/${draft.id}/cancel`).set(headers).expect(409);
      expect(response.body.error.code).toBe('RX_LOCKED');
    });

    test('cancelling a draft frees the visit for another', async () => {
      const { doctor, patientId } = await aClinic('+923002220063');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      const visitId = visit.body.data.id;

      const first = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId, visitId }).expect(201);
      await request(app).post(`/api/v1/prescriptions/${first.body.data.id}/cancel`).set(headers).expect(200);

      const second = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId, visitId }).expect(201);
      expect(second.body.data.id).not.toBe(first.body.data.id);
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

  describe('one open draft per visit', () => {
    test('a second create for the same visit returns the first, with 200 rather than 201', async () => {
      const { doctor, patientId } = await aClinic('+923002220020');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      const visitId = visit.body.data.id;

      const first = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId, visitId }).expect(201);
      const second = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId, visitId }).expect(200);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(await Prescription.countDocuments({ visitId })).toBe(1);
    });

    test('two devices at once still make only one draft', async () => {
      const { doctor, patientId } = await aClinic('+923002220021');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      const visitId = visit.body.data.id;

      const [a, b] = await Promise.all([
        request(app).post('/api/v1/prescriptions').set(headers).send({ patientId, visitId }),
        request(app).post('/api/v1/prescriptions').set(headers).send({ patientId, visitId }),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.data.id).toBe(b.body.data.id);
    });

    test('an approved prescription does not block a new draft for the same visit', async () => {
      const { doctor, patientId } = await aClinic('+923002220022');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      const visitId = visit.body.data.id;

      const first = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId, visitId }).expect(201);
      await request(app)
        .patch(`/api/v1/prescriptions/${first.body.data.id}`)
        .set(headers)
        .send(addMedicine('Panadol'))
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${first.body.data.id}/approve`).set(headers).expect(200);

      // The consultation is over; a second one that day starts fresh.
      const next = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId, visitId }).expect(201);
      expect(next.body.data.id).not.toBe(first.body.data.id);
    });

    test('without a visit, every create is a new draft', async () => {
      const { doctor, patientId } = await aClinic('+923002220023');
      const headers = headersFor(doctor, { location: true });

      const a = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
      const b = await request(app).post('/api/v1/prescriptions').set(headers).send({ patientId }).expect(201);
      expect(a.body.data.id).not.toBe(b.body.data.id);
    });
  });

  describe('the complaints the assistant already took', () => {
    test('start on the draft, and count as an edit like any other change', async () => {
      const { doctor, patientId } = await aClinic('+923002220030');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);

      await request(app)
        .put(`/api/v1/visits/${visit.body.data.id}/vitals`)
        .set(headers)
        .send({ pulse: 88, complaints: 'Fever and body aches since Monday' })
        .expect(200);

      const draft = await request(app)
        .post('/api/v1/prescriptions')
        .set(headers)
        .send({ patientId, visitId: visit.body.data.id })
        .expect(201);

      expect(draft.body.data.sections.complaints).toHaveLength(1);
      expect(draft.body.data.sections.complaints[0].text).toBe('Fever and body aches since Monday');
      // Through the ordinary op path, so it is in the edit log.
      expect(draft.body.data.editCount).toBe(1);
    });

    test('a later edit is never overwritten by a second create', async () => {
      const { doctor, patientId } = await aClinic('+923002220031');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      await request(app)
        .put(`/api/v1/visits/${visit.body.data.id}/vitals`)
        .set(headers)
        .send({ pulse: 88, complaints: 'Fever' })
        .expect(200);

      const draft = await request(app)
        .post('/api/v1/prescriptions')
        .set(headers)
        .send({ patientId, visitId: visit.body.data.id })
        .expect(201);

      const itemId = draft.body.data.sections.complaints[0].id;
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.body.data.id}`)
        .set(headers)
        .send({ ops: [{ op: 'update', section: 'complaints', itemId, value: { text: 'Fever, five days' } }] })
        .expect(200);

      const again = await request(app)
        .post('/api/v1/prescriptions')
        .set(headers)
        .send({ patientId, visitId: visit.body.data.id })
        .expect(200);

      expect(again.body.data.sections.complaints).toHaveLength(1);
      expect(again.body.data.sections.complaints[0].text).toBe('Fever, five days');
    });

    test('nothing is added when the vitals carry no complaints', async () => {
      const { doctor, patientId } = await aClinic('+923002220032');
      const headers = headersFor(doctor, { location: true });
      const visit = await request(app).post('/api/v1/visits').set(headers).send({ patientId }).expect(201);
      await request(app).put(`/api/v1/visits/${visit.body.data.id}/vitals`).set(headers).send({ pulse: 88 }).expect(200);

      const draft = await request(app)
        .post('/api/v1/prescriptions')
        .set(headers)
        .send({ patientId, visitId: visit.body.data.id })
        .expect(201);

      expect(draft.body.data.sections.complaints).toHaveLength(0);
      expect(draft.body.data.editCount).toBe(0);
    });
  });

  describe('a flagged line blocks approval', () => {
    const flagged = (name: string, flags: string[]) => ({
      ops: [{ op: 'add', section: 'medicines', value: { name, flags } }],
    });

    test('approve answers RX_HAS_FLAGS and names the lines', async () => {
      const { doctor, patientId } = await aClinic('+923002220040');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send(flagged('Augmentin', ['dose_unclear']))
        .expect(200);
      const withFlag = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send(flagged('Mystery syrup', ['drug_unknown']))
        .expect(200);

      const refused = await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(409);
      expect(refused.body.error.code).toBe('RX_HAS_FLAGS');
      expect(refused.body.error.details.itemIds).toEqual(
        withFlag.body.data.sections.medicines.map((m: { id: string }) => m.id),
      );

      // Nothing was signed, and no number was spent.
      const unchanged = await Prescription.findById(draft.id);
      expect(unchanged?.status).toBe('draft');
      expect(unchanged?.number).toBeNull();
    });

    test('a typed correction clears the flag and lets it through', async () => {
      const { doctor, patientId } = await aClinic('+923002220041');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      const added = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send(flagged('Augmentin', ['dose_unclear']))
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(409);

      const itemId = added.body.data.sections.medicines[0].id;
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({ ops: [{ op: 'update', section: 'medicines', itemId, value: { durationDays: 5 } }] })
        .expect(200);

      const approved = await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);
      expect(approved.body.data.status).toBe('approved');
    });

    test('removing the flagged line also works', async () => {
      const { doctor, patientId } = await aClinic('+923002220042');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Panadol')).expect(200);
      const added = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send(flagged('Mystery syrup', ['drug_unknown']))
        .expect(200);

      const itemId = added.body.data.sections.medicines[1].id;
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({ ops: [{ op: 'remove', section: 'medicines', itemId }] })
        .expect(200);

      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);
    });
  });

  describe('preview', () => {
    test('shows a draft, marked, with no number and a live letterhead', async () => {
      const { doctor, patientId } = await aClinic('+923002220050', 'Dr Ayesha Khan');
      const headers = headersFor(doctor, { location: true });
      await request(app)
        .patch(`/api/v1/locations/${doctor.locationId}`)
        .set(headersFor(doctor))
        .send({ name: 'Shifa Clinic', address: '12 Jail Road, Lahore' })
        .expect(200);

      const draft = await aDraft(doctor, patientId);
      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Panadol')).expect(200);

      // /pdf still refuses a draft; /preview is the one that does not.
      const pdf = await request(app).get(`/api/v1/prescriptions/${draft.id}/pdf`).set(headers).expect(409);
      expect(pdf.body.error.code).toBe('RX_NOT_APPROVED');

      const preview = await request(app).get(`/api/v1/prescriptions/${draft.id}/preview`).set(headers).expect(200);
      expect(preview.body.data.url).toBeTruthy();
      expect(new Date(preview.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const page = await readPreview(preview.body.data.url);
      expect(page).toContain('DRAFT');
      expect(page).toContain('NOT VALID');
      // The letterhead is read live, because there is no frozen one yet.
      expect(page).toContain('Shifa Clinic');
      expect(page).toContain('12 Jail Road, Lahore');
      expect(page).toContain('Dr Ayesha Khan');
      expect(page).not.toMatch(/RX-\d{4}-\d{6}/);

      // It is not the prescription's print file.
      const stored = await Prescription.findById(draft.id);
      expect(stored?.pdfKey).toBeNull();
      expect(stored?.status).toBe('draft');
    });

    test('shows an approved prescription as it was signed, unmarked', async () => {
      const { doctor, patientId } = await aClinic('+923002220051');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);
      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Panadol')).expect(200);
      const approved = await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

      const preview = await request(app).get(`/api/v1/prescriptions/${draft.id}/preview`).set(headers).expect(200);
      const page = await readPreview(preview.body.data.url);

      expect(page).not.toContain('NOT VALID');
      expect(page).toContain(approved.body.data.number);
    });

    test('prints the Urdu dose line the app showed', async () => {
      const { doctor, patientId } = await aClinic('+923002220052');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({
          ops: [
            {
              op: 'add',
              section: 'medicines',
              value: { name: 'Panadol', strength: '500mg', pattern: { m: 1, a: 0, n: 1 }, timing: 'after_meal' },
            },
          ],
        })
        .expect(200);

      const preview = await request(app).get(`/api/v1/prescriptions/${draft.id}/preview`).set(headers).expect(200);
      const page = await readPreview(preview.body.data.url);

      expect(page).toContain(doseInstruction({ form: 'tab', pattern: { m: 1, a: 0, n: 1 }, timing: 'after_meal' }, 'ur'));
      expect(page).toContain('1 tablet in the morning and at night, after meal');
    });

    test('an edit gives a fresh preview rather than a stale page', async () => {
      const { doctor, patientId } = await aClinic('+923002220053');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);
      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Panadol')).expect(200);

      const before = await request(app).get(`/api/v1/prescriptions/${draft.id}/preview`).set(headers).expect(200);
      expect(await readPreview(before.body.data.url)).toContain('Panadol');

      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Brufen')).expect(200);
      const after = await request(app).get(`/api/v1/prescriptions/${draft.id}/preview`).set(headers).expect(200);

      expect(after.body.data.url).not.toBe(before.body.data.url);
      expect(await readPreview(after.body.data.url)).toContain('Brufen');
    });

    test('a PA may look but still may not approve', async () => {
      const { doctor, patientId } = await aClinic('+923002220054');
      const pa = await aPa(doctor, '+923002220055');
      const paHeaders = {
        Authorization: `Bearer ${pa.accessToken}`,
        'X-Practice-Id': doctor.practiceId,
        'X-Location-Id': doctor.locationId,
      };
      const draft = await aDraft(doctor, patientId);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headersFor(doctor, { location: true }))
        .send(addMedicine('Panadol'))
        .expect(200);

      await request(app).get(`/api/v1/prescriptions/${draft.id}/preview`).set(paHeaders).expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(paHeaders).expect(403);
    });
  });

  describe('audit', () => {
    test('every write is recorded, append-only, under the practice', async () => {
      const { doctor, patientId } = await aClinic('+923002220011');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);

      await request(app).patch(`/api/v1/prescriptions/${draft.id}`).set(headers).send(addMedicine('Zithromax')).expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);
      const revision = await request(app).post(`/api/v1/prescriptions/${draft.id}/revise`).set(headers).send({}).expect(201);
      // Superseding is recorded when version 2 is signed, not when it opens.
      await request(app)
        .patch(`/api/v1/prescriptions/${revision.body.data.id}`)
        .set(headers)
        .send(addMedicine('Flagyl'))
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${revision.body.data.id}/approve`).set(headers).expect(200);

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
