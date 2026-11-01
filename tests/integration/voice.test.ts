import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, dictate, headersFor, speak, waitFor, type SignedIn } from '../fixtures/clinic.fixture';
import { Prescription, VoiceSession } from '../../src/models';
import { voiceSessionViewSchema } from '../../src/shared/voice.schema';

setupTestDB();

const upload = (doctor: SignedIn, prescriptionId: string, seq: number, audioBase64: string) =>
  request(app)
    .post(`/api/v1/prescriptions/${prescriptionId}/voice/segments`)
    .set(headersFor(doctor, { location: true }))
    .send({ seq, durationMs: 2500, contentType: 'audio/m4a', audioBase64 });

/** Dictation is processed in the background, so the app polls - and so does this. */
const settled = async (doctor: SignedIn, prescriptionId: string, seq: number) => {
  const session = await waitFor(
    async () => {
      const response = await request(app)
        .get(`/api/v1/prescriptions/${prescriptionId}/voice`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      return response.body.data;
    },
    (data) => {
      const segment = data.segments.find((candidate: { seq: number }) => candidate.seq === seq);
      return Boolean(segment) && ['applied', 'failed'].includes(segment.status);
    },
  );
  return session.segments.find((segment: { seq: number }) => segment.seq === seq);
};

describe('Voice dictation', () => {
  describe('polling before the first recording', () => {
    test('returns a valid empty session and never a bodyless 304', async () => {
      const { doctor, patientId } = await aClinic('+923003330000');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');
      const url = `/api/v1/prescriptions/${draft.id}/voice`;

      const first = await request(app).get(url).set(headers).expect(200);
      expect(first.headers['cache-control']).toBe('no-store');
      expect(voiceSessionViewSchema.parse(first.body.data)).toMatchObject({
        prescriptionId: draft.id,
        status: 'open',
        segments: [],
        audioDeleteAfter: null,
      });

      const revalidated = await request(app)
        .get(url)
        .set(headers)
        .set('If-None-Match', first.headers.etag as string)
        .expect(200);
      expect(revalidated.body.data.id).toBe(first.body.data.id);
      expect(revalidated.body.data.segments).toEqual([]);
      expect(await VoiceSession.countDocuments({ prescriptionId: draft.id })).toBe(1);
    });

    test('the first upload uses the empty session and sequence 1', async () => {
      const { doctor, patientId } = await aClinic('+923003330099');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      const empty = await request(app).get(`/api/v1/prescriptions/${draft.id}/voice`).set(headers).expect(200);
      const accepted = await upload(
        doctor,
        draft.id,
        1,
        dictate([{ op: 'add', section: 'advice', value: { text: 'Rest' } }]),
      ).expect(201);

      expect(accepted.body.data.seq).toBe(1);
      const session = await VoiceSession.findOne({ prescriptionId: draft.id });
      expect(String(session?._id)).toBe(empty.body.data.id);
      expect(session?.segments).toHaveLength(1);
    });

    test('repairs the timestamp duration sent by the older Android build', async () => {
      const { doctor, patientId } = await aClinic('+923003330098');
      const draft = await aDraft(doctor, patientId, 'voice');
      const audioBase64 = dictate([{ op: 'add', section: 'advice', value: { text: 'Rest' } }]);

      const accepted = await request(app)
        .post(`/api/v1/prescriptions/${draft.id}/voice/segments`)
        .set(headersFor(doctor, { location: true }))
        .send({
          seq: 1,
          durationMs: 1_760_000_000_000_000,
          contentType: 'audio/m4a',
          audioBase64,
        })
        .expect(201);

      expect(accepted.body.data.audio.durationMs).toBeGreaterThanOrEqual(1000);
      expect(accepted.body.data.audio.durationMs).toBeLessThanOrEqual(30 * 60 * 1000);

      await request(app)
        .post(`/api/v1/prescriptions/${draft.id}/voice/segments`)
        .set(headersFor(doctor, { location: true }))
        .send({ seq: 2, durationMs: 30 * 60 * 1000 + 1, contentType: 'audio/m4a', audioBase64 })
        .expect(400);
    });
  });

  /**
   * Rule 6. Voice does not write to a prescription: it produces ops, and the
   * server decides whether they are allowed anywhere near a section.
   */
  describe('the server validates ops before applying them', () => {
    test('a valid op list is applied, and each line traces back to a span', async () => {
      const { doctor, patientId } = await aClinic('+923003330001');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      const accepted = await upload(
        doctor,
        draft.id,
        1,
        dictate([
          { op: 'add', section: 'complaints', value: { text: 'Bukhar teen din se' } },
          {
            op: 'add',
            section: 'medicines',
            value: { name: 'Panadol', strength: '500mg', pattern: { m: 1, a: 0, n: 1 }, durationDays: 5 },
          },
        ]),
      ).expect(201);
      expect(accepted.body.data.status).toBe('uploaded');

      const segment = await settled(doctor, draft.id, 1);
      expect(segment.status).toBe('applied');
      expect(segment.ops).toHaveLength(2);

      const prescription = await request(app).get(`/api/v1/prescriptions/${draft.id}`).set(headers).expect(200);
      expect(prescription.body.data.sections.complaints[0].text).toBe('Bukhar teen din se');
      expect(prescription.body.data.sections.medicines[0]).toMatchObject({
        name: 'Panadol',
        strength: '500mg',
        durationDays: 5,
      });
      // Dictation is not a doctor correction, so the edit log stays empty.
      expect(prescription.body.data.editCount).toBe(0);
      expect(prescription.body.data.source).toBe('voice');
    });

    test('an op naming a section that does not exist never reaches the prescription', async () => {
      const { doctor, patientId } = await aClinic('+923003330002');
      const draft = await aDraft(doctor, patientId, 'voice');

      await upload(doctor, draft.id, 1, dictate([{ op: 'add', section: 'secretNotes', value: { text: 'nope' } }])).expect(
        201,
      );

      const segment = await settled(doctor, draft.id, 1);
      expect(segment.status).toBe('failed');
      expect(segment.error).toMatch(/shape/i);

      const prescription = await Prescription.findById(draft.id);
      expect(Object.keys(prescription!.toObject().sections)).not.toContain('secretNotes');
    });

    test('an op with a value the section does not accept fails the segment, not the draft', async () => {
      const { doctor, patientId } = await aClinic('+923003330003');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      // A medicine with no name, and a dose pattern that is not one of the two
      // shapes the contract allows.
      await upload(
        doctor,
        draft.id,
        1,
        dictate([{ op: 'add', section: 'medicines', value: { strength: '500mg', pattern: { morning: 'two' } } }]),
      ).expect(201);

      const segment = await settled(doctor, draft.id, 1);
      expect(segment.status).toBe('failed');
      expect(segment.error).toContain('op 0');

      const prescription = await request(app).get(`/api/v1/prescriptions/${draft.id}`).set(headers).expect(200);
      expect(prescription.body.data.sections.medicines).toHaveLength(0);
    });

    test('an op addressing an item id that was never minted is refused', async () => {
      const { doctor, patientId } = await aClinic('+923003330004');
      const draft = await aDraft(doctor, patientId, 'voice');

      await upload(
        doctor,
        draft.id,
        1,
        dictate([{ op: 'update', section: 'diagnosis', itemId: 'made-up-id', value: { text: 'Dengue' } }]),
      ).expect(201);

      const segment = await settled(doctor, draft.id, 1);
      expect(segment.status).toBe('failed');
      expect(segment.error).toContain('made-up-id');
    });

    test('a failed segment can be retried once the extractor returns something valid', async () => {
      const { doctor, patientId } = await aClinic('+923003330005');
      const draft = await aDraft(doctor, patientId, 'voice');

      await upload(doctor, draft.id, 1, dictate([{ op: 'remove', section: 'advice', itemId: 'ghost' }])).expect(201);
      const failed = await settled(doctor, draft.id, 1);
      expect(failed.status).toBe('failed');

      // The recording is still there, so the doctor need not say it again.
      const retried = await request(app)
        .post(`/api/v1/voice/segments/${failed.id}/retry`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      expect(retried.body.data.status).toBe('uploaded');

      // Same audio, same extractor, so it fails the same way - which is the
      // point: a retry is a retry, not a bypass.
      const again = await settled(doctor, draft.id, 1);
      expect(again.status).toBe('failed');
    });
  });

  describe('segments apply strictly in order', () => {
    test('an upload that skips ahead is refused', async () => {
      const { doctor, patientId } = await aClinic('+923003330006');
      const draft = await aDraft(doctor, patientId, 'voice');

      const skipped = await upload(doctor, draft.id, 3, speak('Sar dard')).expect(409);
      expect(skipped.body.error.code).toBe('SEGMENT_OUT_OF_ORDER');

      await upload(doctor, draft.id, 1, speak('Sar dard')).expect(201);
      await settled(doctor, draft.id, 1);

      const duplicate = await upload(doctor, draft.id, 1, speak('Sar dard')).expect(409);
      expect(duplicate.body.error.code).toBe('SEGMENT_DUPLICATE');
    });

    test('three segments in a row land in the order they were spoken', async () => {
      const { doctor, patientId } = await aClinic('+923003330007');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      await upload(doctor, draft.id, 1, speak('Pehli shikayat')).expect(201);
      await settled(doctor, draft.id, 1);
      await upload(doctor, draft.id, 2, speak('Dusri shikayat')).expect(201);
      await settled(doctor, draft.id, 2);
      await upload(doctor, draft.id, 3, speak('Teesri shikayat')).expect(201);
      await settled(doctor, draft.id, 3);

      const prescription = await request(app).get(`/api/v1/prescriptions/${draft.id}`).set(headers).expect(200);
      expect(prescription.body.data.sections.complaints.map((item: { text: string }) => item.text)).toEqual([
        'Pehli shikayat',
        'Dusri shikayat',
        'Teesri shikayat',
      ]);
    });
  });

  describe('a dictation session belongs to a draft', () => {
    test('nothing can be dictated into an approved prescription', async () => {
      const { doctor, patientId } = await aClinic('+923003330008');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      await upload(doctor, draft.id, 1, speak('Bukhar')).expect(201);
      await settled(doctor, draft.id, 1);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

      const refused = await upload(doctor, draft.id, 2, speak('Aur khansi')).expect(409);
      expect(refused.body.error.code).toBe('RX_LOCKED');
    });

    test('approval starts the retention clock on the audio, and the sweep deletes it', async () => {
      const { doctor, patientId } = await aClinic('+923003330009');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      await upload(doctor, draft.id, 1, speak('Bukhar')).expect(201);
      const segment = await settled(doctor, draft.id, 1);

      await request(app)
        .patch('/api/v1/practice')
        .set(headersFor(doctor))
        .send({ settings: { audioRetentionDays: 7 } })
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

      const closed = await VoiceSession.findOne({ prescriptionId: draft.id });
      expect(closed?.status).toBe('closed');
      expect(closed?.audioDeleteAfter).not.toBeNull();

      // The recording is still fetchable while it is being kept.
      const url = await request(app)
        .get(`/api/v1/voice/segments/${segment.id}/audio`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      expect(url.body.data.url).toBeTruthy();

      // Eight days later it is not.
      const { sweepExpiredAudio } = await import('../../src/services/voice.service');
      const deleted = await sweepExpiredAudio(new Date(Date.now() + 8 * 86_400_000));
      expect(deleted).toBe(1);

      const afterSweep = await VoiceSession.findOne({ prescriptionId: draft.id });
      expect(afterSweep?.segments[0].audio.deletedAt).not.toBeNull();
      // The transcript survives; only the patient's voice is gone.
      expect(afterSweep?.segments[0].transcript).toBe('Bukhar');

      const gone = await request(app)
        .get(`/api/v1/voice/segments/${segment.id}/audio`)
        .set(headersFor(doctor, { location: true }))
        .expect(404);
      expect(gone.body.error.code).toBe('NOT_FOUND');
    });

    test('dictation can be switched off per clinic', async () => {
      const { doctor, patientId } = await aClinic('+923003330010');
      const draft = await aDraft(doctor, patientId, 'voice');

      await request(app)
        .patch('/api/v1/practice')
        .set(headersFor(doctor))
        .send({ features: { voice: false } })
        .expect(200);

      const refused = await upload(doctor, draft.id, 1, speak('Bukhar')).expect(403);
      expect(refused.body.error.code).toBe('FEATURE_DISABLED');
    });
  });

  describe('a typed edit over dictation', () => {
    test('is recorded in the edit log and clears the pipeline flags', async () => {
      const { doctor, patientId } = await aClinic('+923003330011');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      await upload(
        doctor,
        draft.id,
        1,
        dictate([
          {
            op: 'add',
            section: 'medicines',
            value: { name: 'Augmentin', strength: '625mg', pattern: { m: 1, a: 0, n: 1 }, flags: ['dose_unclear'] },
          },
        ]),
      ).expect(201);
      await settled(doctor, draft.id, 1);

      const before = await request(app).get(`/api/v1/prescriptions/${draft.id}`).set(headers).expect(200);
      const medicine = before.body.data.sections.medicines[0];
      expect(medicine.flags).toEqual(['dose_unclear']);

      const after = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({ ops: [{ op: 'update', section: 'medicines', itemId: medicine.id, value: { durationDays: 7 } }] })
        .expect(200);

      const corrected = after.body.data.sections.medicines[0];
      expect(corrected.durationDays).toBe(7);
      // The doctor has looked at the line, so what the pipeline was unsure
      // about is settled.
      expect(corrected.flags).toEqual([]);
      expect(after.body.data.editCount).toBe(1);
      expect(after.body.data.source).toBe('mixed');
    });
  });
});
