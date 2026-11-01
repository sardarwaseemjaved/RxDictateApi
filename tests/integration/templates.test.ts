import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, aPa, headersFor, pause, signIn, type SignedIn } from '../fixtures/clinic.fixture';
import { AuditLog, Template } from '../../src/models';

setupTestDB();

/** What the doctor would build on the template screen, carrying things a template must not keep. */
const hypertension = {
  diagnosis: [{ id: 'd1', text: 'Hypertension' }],
  medicines: [
    {
      id: 'm1',
      name: 'Amlodipine',
      strength: '5mg',
      pattern: { m: 1, a: 0, n: 0 },
      durationDays: 30,
      flags: ['dose_unclear'],
      correctedBySpeech: true,
      sourceSpanIds: ['s1'],
    },
    { id: 'm2', name: 'Losartan', strength: '50mg', pattern: { m: 0, a: 0, n: 1 }, durationDays: 30 },
  ],
  labs: [{ id: 'l1', text: 'Lipid profile', sourceSpanIds: ['s2'] }],
  advice: [{ id: 'a1', text: 'Cut down on salt' }],
  followUp: { inDays: 30, date: '2026-12-01', note: 'Bring BP diary', bookByAssistant: true },
};

const aTemplate = async (doctor: SignedIn, name = 'Hypertension', sections: object = hypertension) => {
  const created = await request(app).post('/api/v1/templates').set(headersFor(doctor)).send({ name, sections }).expect(201);
  return created.body.data;
};

const aSecondDoctor = async (doctor: SignedIn, phone: string): Promise<SignedIn> => {
  await request(app)
    .post('/api/v1/members')
    .set(headersFor(doctor))
    .send({ phone, name: 'Dr Bilal', role: 'doctor', locationIds: [doctor.locationId] })
    .expect(201);
  return signIn(phone);
};

const paHeaders = (doctor: SignedIn, pa: SignedIn) => ({
  Authorization: `Bearer ${pa.accessToken}`,
  'X-Practice-Id': doctor.practiceId,
  'X-Location-Id': doctor.locationId,
});

describe('Rx templates', () => {
  describe('making one', () => {
    test('keeps the regimen and drops what belongs to one patient or one dictation', async () => {
      const { doctor } = await aClinic('+923024440001');
      const template = await aTemplate(doctor);

      expect(template).toMatchObject({ name: 'Hypertension', useCount: 0, lastUsedAt: null });
      expect(template.sections.medicines).toHaveLength(2);
      expect(template.sections.medicines[0]).toMatchObject({
        name: 'Amlodipine',
        strength: '5mg',
        flags: [],
        correctedBySpeech: false,
        sourceSpanIds: [],
      });
      expect(template.sections.labs[0].sourceSpanIds).toEqual([]);
      // The interval is the habit; the date was one patient's.
      expect(template.sections.followUp).toMatchObject({ inDays: 30, date: null, note: 'Bring BP diary' });
      // Sections not sent are there, empty, as on a prescription.
      expect(template.sections.complaints).toEqual([]);

      const audit = await AuditLog.findOne({ action: 'template.create' });
      expect(String(audit?.entityId)).toBe(template.id);
    });

    test('"Save as template" copies an approved prescription, but not its patient', async () => {
      const { doctor, patientId } = await aClinic('+923024440002');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({
          ops: [
            { op: 'add', section: 'complaints', value: { text: 'Headache for 3 days' } },
            { op: 'add', section: 'examination', value: { text: 'BP 160/100' } },
            { op: 'add', section: 'diagnosis', value: { text: 'Hypertension' } },
            { op: 'add', section: 'medicines', value: { name: 'Amlodipine', strength: '5mg' } },
            { op: 'add', section: 'labs', value: { text: 'RFT' } },
            { op: 'update', section: 'followUp', value: { inDays: 14, date: '2026-11-20' } },
          ],
        })
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

      const created = await request(app)
        .post('/api/v1/templates')
        .set(headersFor(doctor))
        .send({ name: 'HTN follow-up', fromPrescriptionId: draft.id })
        .expect(201);
      const { sections } = created.body.data;

      expect(sections.complaints).toEqual([]);
      expect(sections.examination).toEqual([]);
      expect(sections.history).toEqual([]);
      expect(sections.diagnosis.map((item: { text: string }) => item.text)).toEqual(['Hypertension']);
      expect(sections.medicines.map((item: { name: string }) => item.name)).toEqual(['Amlodipine']);
      expect(sections.labs.map((item: { text: string }) => item.text)).toEqual(['RFT']);
      expect(sections.followUp).toMatchObject({ inDays: 14, date: null });
    });

    test('only from an approved prescription', async () => {
      const { doctor, patientId } = await aClinic('+923024440003');
      const draft = await aDraft(doctor, patientId);

      const response = await request(app)
        .post('/api/v1/templates')
        .set(headersFor(doctor))
        .send({ name: 'Draft', fromPrescriptionId: draft.id })
        .expect(409);
      expect(response.body.error.code).toBe('RX_NOT_APPROVED');
    });

    test('takes sections or a prescription, not both and not neither', async () => {
      const { doctor, patientId } = await aClinic('+923024440004');
      const draft = await aDraft(doctor, patientId);
      const headers = headersFor(doctor);

      await request(app).post('/api/v1/templates').set(headers).send({ name: 'Nothing' }).expect(400);
      await request(app)
        .post('/api/v1/templates')
        .set(headers)
        .send({ name: 'Both', sections: hypertension, fromPrescriptionId: draft.id })
        .expect(400);
      await request(app).post('/api/v1/templates').set(headers).send({ sections: hypertension }).expect(400);
    });

    test('refuses one with nothing on it', async () => {
      const { doctor } = await aClinic('+923024440005');
      const response = await request(app)
        .post('/api/v1/templates')
        .set(headersFor(doctor))
        .send({ name: 'Empty', sections: {} })
        .expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    test('one name per doctor, in any case', async () => {
      const { doctor } = await aClinic('+923024440006');
      await aTemplate(doctor, 'Hypertension');

      const clash = await request(app)
        .post('/api/v1/templates')
        .set(headersFor(doctor))
        .send({ name: 'HYPERTENSION', sections: hypertension })
        .expect(409);
      expect(clash.body.error.code).toBe('CONFLICT');
    });
  });

  describe('listing, reading, editing and deleting', () => {
    test('lists most used first, searches the name, and pages', async () => {
      const { doctor, patientId } = await aClinic('+923024440010');
      const fever = await aTemplate(doctor, 'Viral fever', { advice: [{ id: 'a', text: 'Fluids' }] });
      await aTemplate(doctor, 'Hypertension');
      await aTemplate(doctor, 'Gastritis', { advice: [{ id: 'a', text: 'Small meals' }] });

      await request(app)
        .post(`/api/v1/prescriptions/from-template/${fever.id}`)
        .set(headersFor(doctor, { location: true }))
        .send({ patientId })
        .expect(201);

      const all = await request(app).get('/api/v1/templates').set(headersFor(doctor)).expect(200);
      expect(all.body.data.map((t: { name: string }) => t.name)).toEqual(['Viral fever', 'Gastritis', 'Hypertension']);
      expect(all.body.meta).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });

      const searched = await request(app).get('/api/v1/templates').query({ q: 'TENS' }).set(headersFor(doctor)).expect(200);
      expect(searched.body.data.map((t: { name: string }) => t.name)).toEqual(['Hypertension']);

      // Typed text is matched literally, not as a pattern.
      const literal = await request(app).get('/api/v1/templates').query({ q: '.*' }).set(headersFor(doctor)).expect(200);
      expect(literal.body.data).toHaveLength(0);

      const paged = await request(app).get('/api/v1/templates').query({ limit: 2, page: 2 }).set(headersFor(doctor));
      expect(paged.body.data.map((t: { name: string }) => t.name)).toEqual(['Hypertension']);
    });

    test('reads, renames and replaces sections, keeping the rules', async () => {
      const { doctor } = await aClinic('+923024440011');
      const template = await aTemplate(doctor);
      await aTemplate(doctor, 'Gastritis', { advice: [{ id: 'a', text: 'Small meals' }] });

      const read = await request(app).get(`/api/v1/templates/${template.id}`).set(headersFor(doctor)).expect(200);
      expect(read.body.data.name).toBe('Hypertension');

      const renamed = await request(app)
        .patch(`/api/v1/templates/${template.id}`)
        .set(headersFor(doctor))
        .send({ name: 'HTN', sections: { medicines: [{ id: 'x', name: 'Telmisartan', flags: ['drug_unknown'] }] } })
        .expect(200);
      expect(renamed.body.data.name).toBe('HTN');
      expect(renamed.body.data.sections.medicines).toHaveLength(1);
      expect(renamed.body.data.sections.medicines[0]).toMatchObject({ name: 'Telmisartan', flags: [] });
      expect(renamed.body.data.sections.advice).toEqual([]);

      const clash = await request(app)
        .patch(`/api/v1/templates/${template.id}`)
        .set(headersFor(doctor))
        .send({ name: 'gastritis' })
        .expect(409);
      expect(clash.body.error.code).toBe('CONFLICT');

      // Its own name back, in another case, is not a clash with itself.
      await request(app).patch(`/api/v1/templates/${template.id}`).set(headersFor(doctor)).send({ name: 'htn' }).expect(200);

      await request(app).patch(`/api/v1/templates/${template.id}`).set(headersFor(doctor)).send({}).expect(400);
    });

    test('a deleted template is gone from every read, and kept on record', async () => {
      const { doctor } = await aClinic('+923024440012');
      const template = await aTemplate(doctor);

      const deleted = await request(app).delete(`/api/v1/templates/${template.id}`).set(headersFor(doctor)).expect(200);
      expect(deleted.body.data.id).toBe(template.id);

      await request(app).get(`/api/v1/templates/${template.id}`).set(headersFor(doctor)).expect(404);
      await request(app).delete(`/api/v1/templates/${template.id}`).set(headersFor(doctor)).expect(404);
      const list = await request(app).get('/api/v1/templates').set(headersFor(doctor)).expect(200);
      expect(list.body.data).toHaveLength(0);

      // Soft: the row is still there.
      const stored = await Template.findById(template.id);
      expect(stored?.deletedAt).not.toBeNull();
      // And its name is free again.
      await aTemplate(doctor);
    });
  });

  describe('who may', () => {
    test('a PA may not list, make, read, edit, delete or use one', async () => {
      const { doctor, patientId } = await aClinic('+923024440020');
      const template = await aTemplate(doctor);
      const pa = await aPa(doctor, '+923024440021');
      const headers = paHeaders(doctor, pa);

      const attempts = [
        request(app).get('/api/v1/templates').set(headers),
        request(app).post('/api/v1/templates').set(headers).send({ name: 'Mine', sections: hypertension }),
        request(app).get(`/api/v1/templates/${template.id}`).set(headers),
        request(app).patch(`/api/v1/templates/${template.id}`).set(headers).send({ name: 'Mine' }),
        request(app).delete(`/api/v1/templates/${template.id}`).set(headers),
        request(app).post(`/api/v1/prescriptions/from-template/${template.id}`).set(headers).send({ patientId }),
      ];
      const responses = await Promise.all(attempts);
      responses.forEach((response) => {
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('FORBIDDEN');
      });
    });

    test("each doctor keeps their own: a colleague's template is not found", async () => {
      const { doctor, patientId } = await aClinic('+923024440022');
      const template = await aTemplate(doctor);
      const colleague = await aSecondDoctor(doctor, '+923024440023');

      const list = await request(app).get('/api/v1/templates').set(headersFor(colleague)).expect(200);
      expect(list.body.data).toHaveLength(0);

      await request(app).get(`/api/v1/templates/${template.id}`).set(headersFor(colleague)).expect(404);
      await request(app)
        .patch(`/api/v1/templates/${template.id}`)
        .set(headersFor(colleague))
        .send({ name: 'x' })
        .expect(404);
      await request(app).delete(`/api/v1/templates/${template.id}`).set(headersFor(colleague)).expect(404);
      await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headersFor(colleague, { location: true }))
        .send({ patientId })
        .expect(404);

      // And the same name is free for them.
      await aTemplate(colleague, 'Hypertension');
    });

    test("another clinic's template is not found", async () => {
      const a = await aClinic('+923024440024');
      const b = await aClinic('+923024440025');
      const template = await aTemplate(b.doctor);

      await request(app).get(`/api/v1/templates/${template.id}`).set(headersFor(a.doctor)).expect(404);
      await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headersFor(a.doctor, { location: true }))
        .send({ patientId: a.patientId })
        .expect(404);
    });
  });

  describe('starting a prescription from one', () => {
    test('makes a draft that is a copy, with fresh ids, and counts the use', async () => {
      const { doctor, patientId } = await aClinic('+923024440030');
      const template = await aTemplate(doctor);

      const started = await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headersFor(doctor, { location: true }))
        .send({ patientId })
        .expect(201);
      const rx = started.body.data;

      expect(rx).toMatchObject({ status: 'draft', source: 'template', patientId });
      expect(rx.visitId).not.toBeNull();
      expect(rx.sections.medicines.map((m: { name: string }) => m.name)).toEqual(['Amlodipine', 'Losartan']);
      expect(rx.sections.medicines[0]).toMatchObject({ strength: '5mg', durationDays: 30, flags: [] });
      expect(rx.sections.medicines.map((m: { id: string }) => m.id)).not.toContain('m1');
      expect(rx.sections.labs.map((l: { text: string }) => l.text)).toEqual(['Lipid profile']);
      expect(rx.sections.followUp).toMatchObject({ inDays: 30, date: null, note: 'Bring BP diary' });
      // Copied lines are not the doctor correcting anything.
      expect(rx.editCount).toBe(0);

      const after = await request(app).get(`/api/v1/templates/${template.id}`).set(headersFor(doctor)).expect(200);
      expect(after.body.data.useCount).toBe(1);
      expect(after.body.data.lastUsedAt).not.toBeNull();
      // updatedAt means edited, not used.
      expect(after.body.data.updatedAt).toBe(template.updatedAt);

      // Nothing it brought blocks approval.
      await request(app)
        .post(`/api/v1/prescriptions/${rx.id}/approve`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
    });

    test("adds to the visit's open draft without removing or doubling anything", async () => {
      const { doctor, patientId } = await aClinic('+923024440031');
      const headers = headersFor(doctor, { location: true });
      const template = await aTemplate(doctor);

      const draft = await aDraft(doctor, patientId);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({
          ops: [
            { op: 'add', section: 'medicines', value: { name: 'Panadol', strength: '500mg' } },
            // Already there, in another case: not added twice.
            { op: 'add', section: 'medicines', value: { name: 'amlodipine', strength: '5MG' } },
            { op: 'update', section: 'followUp', value: { inDays: 7 } },
          ],
        })
        .expect(200);
      const editsBefore = (await request(app).get(`/api/v1/prescriptions/${draft.id}`).set(headers)).body.data.editCount;

      const merged = await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headers)
        .send({ patientId, visitId: draft.visitId })
        .expect(200);
      const rx = merged.body.data;

      expect(rx.id).toBe(draft.id);
      expect(rx.source).toBe('mixed');
      expect(rx.sections.medicines.map((m: { name: string }) => m.name)).toEqual(['Panadol', 'amlodipine', 'Losartan']);
      expect(rx.sections.diagnosis.map((d: { text: string }) => d.text)).toEqual(['Hypertension']);
      expect(rx.sections.advice.map((a: { text: string }) => a.text)).toEqual(['Cut down on salt']);
      // The doctor's follow-up stands.
      expect(rx.sections.followUp.inDays).toBe(7);
      expect(rx.editCount).toBe(editsBefore);

      const used = await Template.findById(template.id);
      expect(used?.useCount).toBe(1);
    });

    test('with no visitId, finds the open draft for today the same way', async () => {
      const { doctor, patientId } = await aClinic('+923024440032');
      const template = await aTemplate(doctor);
      const draft = await aDraft(doctor, patientId);

      const merged = await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headersFor(doctor, { location: true }))
        .send({ patientId })
        .expect(200);
      expect(merged.body.data.id).toBe(draft.id);
      expect(merged.body.data.source).toBe('mixed');
    });

    test('applying the same template twice adds nothing the second time', async () => {
      const { doctor, patientId } = await aClinic('+923024440033');
      const headers = headersFor(doctor, { location: true });
      const template = await aTemplate(doctor);

      const first = await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headers)
        .send({ patientId });
      const second = await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headers)
        .send({ patientId })
        .expect(200);

      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.source).toBe('template');
      expect(second.body.data.sections.medicines).toHaveLength(2);
      expect((await Template.findById(template.id))?.useCount).toBe(2);
    });

    test('is audited against the template', async () => {
      const { doctor, patientId } = await aClinic('+923024440034');
      const template = await aTemplate(doctor);

      const started = await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headersFor(doctor, { location: true }))
        .send({ patientId })
        .expect(201);
      await pause(10);

      const entry = await AuditLog.findOne({ action: 'prescription.create', entityId: started.body.data.id });
      expect((entry?.after as { templateId?: string }).templateId).toBe(template.id);
    });

    test('needs a patient, and a real one', async () => {
      const { doctor } = await aClinic('+923024440035');
      const b = await aClinic('+923024440036');
      const template = await aTemplate(doctor);
      const headers = headersFor(doctor, { location: true });

      await request(app).post(`/api/v1/prescriptions/from-template/${template.id}`).set(headers).send({}).expect(400);
      await request(app)
        .post(`/api/v1/prescriptions/from-template/${template.id}`)
        .set(headers)
        .send({ patientId: b.patientId })
        .expect(404);
    });
  });
});
