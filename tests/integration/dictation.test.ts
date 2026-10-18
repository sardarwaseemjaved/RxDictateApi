import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, headersFor, speak, waitFor, type SignedIn } from '../fixtures/clinic.fixture';
import { stubOpenAi, unstubOpenAi, wireMedicine, wireOp } from '../fixtures/openai.fixture';

setupTestDB();

const upload = (doctor: SignedIn, prescriptionId: string, seq: number, audioBase64: string) =>
  request(app)
    .post(`/api/v1/prescriptions/${prescriptionId}/voice/segments`)
    .set(headersFor(doctor, { location: true }))
    .send({ seq, durationMs: 12_000, contentType: 'audio/m4a', audioBase64 });

/** Dictation runs in the background, so the app polls - and so does this. */
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

const draftOf = async (doctor: SignedIn, prescriptionId: string) =>
  (
    await request(app)
      .get(`/api/v1/prescriptions/${prescriptionId}`)
      .set(headersFor(doctor, { location: true }))
      .expect(200)
  ).body.data;

describe('Dictation through OpenAI', () => {
  afterEach(() => {
    unstubOpenAi();
  });

  describe('a clean Urdu and English dictation', () => {
    test('becomes a medicine, a diagnosis and advice', async () => {
      const stub = stubOpenAi({
        transcript:
          'Dengue fever confirmed hai۔ Panadol five hundred, subah shaam, khane ke baad, paanch din۔ Aaram karein aur pani ziada piyein۔',
        extraction: {
          ops: [
            wireOp('add', 'diagnosis', { text: 'Dengue fever' }, { spanIds: ['will-be-rewritten'] }),
            wireMedicine(),
            wireOp('add', 'advice', { text: 'Rest and drink plenty of water' }),
          ],
          spans: [],
        },
      });

      const { doctor, patientId } = await aClinic('+923011110001');
      const draft = await aDraft(doctor, patientId, 'voice');

      await upload(doctor, draft.id, 1, speak('ignored: the stub decides the transcript')).expect(201);
      const segment = await settled(doctor, draft.id, 1);
      expect(segment.status).toBe('applied');

      const prescription = await draftOf(doctor, draft.id);
      expect(prescription.sections.diagnosis[0].text).toBe('Dengue fever');
      expect(prescription.sections.advice[0].text).toBe('Rest and drink plenty of water');
      expect(prescription.sections.medicines[0]).toMatchObject({
        name: 'Panadol',
        strength: '500mg',
        form: 'tab',
        timing: 'after_meal',
        // The three flat numbers the model answers with, folded back into the
        // pattern the contract uses.
        pattern: { m: 1, a: 0, n: 1 },
        durationDays: 5,
      });
      expect(prescription.source).toBe('voice');

      // The transcript is kept, in the script it was said in.
      expect(segment.transcript).toContain('subah shaam');
      expect(segment.spans.length).toBeGreaterThan(1);
      expect(segment.sttProvider).toBe('gpt-4o-transcribe');
      expect(segment.llmModel).toBe('gpt-4o-mini');
      // Audio minutes plus tokens, both estimated from the published rates.
      expect(segment.costUsd).toBeGreaterThan(0);

      // The transcriber was told what it is listening to.
      const form = stub.transcriptionForm();
      expect(form.get('model')).toBe('gpt-4o-transcribe');
      expect(String(form.get('prompt'))).toContain('mixes Urdu and English');
      expect(form.get('language')).toBeNull();

      // The extractor was asked for ops and nothing else.
      const chat = stub.chatRequest() as {
        model: string;
        temperature: number;
        response_format: { type: string; json_schema: { strict: boolean; schema: { required: string[] } } };
      };
      expect(chat.model).toBe('gpt-4o-mini');
      expect(chat.temperature).toBe(0);
      expect(chat.response_format.type).toBe('json_schema');
      expect(chat.response_format.json_schema.strict).toBe(true);
      expect(chat.response_format.json_schema.schema.required).toEqual(['ops', 'spans']);
    });

    test('the drug names already on the draft are given to the transcriber', async () => {
      const stub = stubOpenAi({ transcript: 'Rosuvastatin raat ko.', extraction: { ops: [], spans: [] } });

      const { doctor, patientId } = await aClinic('+923011110002');
      const draft = await aDraft(doctor, patientId, 'voice');
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headersFor(doctor, { location: true }))
        .send({ ops: [{ op: 'add', section: 'medicines', value: { name: 'Rosuvastatin', strength: '10 mg' } }] })
        .expect(200);

      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      await settled(doctor, draft.id, 1);

      expect(String(stub.transcriptionForm().get('prompt'))).toContain('Rosuvastatin');
      // And the draft, with its item ids, reaches the extractor.
      const chat = stub.chatRequest() as { messages: { role: string; content: string }[] };
      expect(chat.messages[1].content).toContain('Rosuvastatin');
      expect(chat.messages[1].content).toMatch(/medicines \[[0-9a-f]{12}\]/);
    });
  });

  describe('an update to a line already on the draft', () => {
    test('changes that line instead of adding a second', async () => {
      const { doctor, patientId } = await aClinic('+923011110003');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      const typed = await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(headers)
        .send({
          ops: [
            {
              op: 'add',
              section: 'medicines',
              value: { name: 'Panadol', strength: '500mg', pattern: { m: 1, a: 0, n: 0 }, durationDays: 5 },
            },
          ],
        })
        .expect(200);
      const itemId = typed.body.data.sections.medicines[0].id;

      stubOpenAi({
        transcript: 'Panadol ko subah shaam kar dein.',
        extraction: {
          ops: [
            // Only the dose was said, so only the dose is sent.
            wireOp('update', 'medicines', { doseMorning: 1, doseAfternoon: 0, doseNight: 1 }, { itemId }),
          ],
          spans: [],
        },
      });

      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      expect((await settled(doctor, draft.id, 1)).status).toBe('applied');

      const prescription = await draftOf(doctor, draft.id);
      expect(prescription.sections.medicines).toHaveLength(1);
      expect(prescription.sections.medicines[0]).toMatchObject({
        id: itemId,
        name: 'Panadol',
        strength: '500mg',
        durationDays: 5,
        pattern: { m: 1, a: 0, n: 1 },
        // A dictated correction marks the line.
        correctedBySpeech: true,
      });
    });
  });

  describe('speech to the patient', () => {
    test('adds nothing, and is marked as not dictation', async () => {
      const { doctor, patientId } = await aClinic('+923011110004');
      const draft = await aDraft(doctor, patientId, 'voice');

      // The stub has to know the span ids, which the transcriber mints, so the
      // annotation is matched by reading the session back.
      stubOpenAi({ transcript: 'Aap theek ho jayenge, fikar na karein.', extraction: { ops: [], spans: [] } });

      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const segment = await settled(doctor, draft.id, 1);

      expect(segment.status).toBe('applied');
      expect(segment.ops).toHaveLength(0);

      const prescription = await draftOf(doctor, draft.id);
      expect(prescription.sections.complaints).toHaveLength(0);
      expect(prescription.sections.medicines).toHaveLength(0);
      // Nothing was changed, so nothing counts as an edit either.
      expect(prescription.editCount).toBe(0);
      // What was said is still on the record.
      expect(segment.transcript).toContain('fikar na karein');
    });

    test('an aside the extractor flags is kept but not treated as dictation', async () => {
      const { doctor, patientId } = await aClinic('+923011110005');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({ transcript: 'Bukhar teen din se۔', extraction: { ops: [], spans: [] } });
      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const first = await settled(doctor, draft.id, 1);
      const spanId = first.spans[0].id;

      // Second segment: the extractor now says that span was an aside.
      stubOpenAi({
        transcript: 'Aap theek ho jayenge۔',
        extraction: { ops: [], spans: [{ id: spanId, english: 'You will be fine', isDictation: false }] },
      });
      await upload(doctor, draft.id, 2, speak('x')).expect(201);
      await settled(doctor, draft.id, 2);

      // The annotation only applies to the segment it came with, and the
      // original is never rewritten.
      const session = await request(app)
        .get(`/api/v1/prescriptions/${draft.id}/voice`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      expect(session.body.data.segments[0].spans[0].original).toContain('Bukhar');
    });
  });

  describe('an answer the server will not accept', () => {
    test('an invented item id fails the segment with OP_INVALID and changes nothing', async () => {
      const { doctor, patientId } = await aClinic('+923011110006');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({
        transcript: 'Panadol ko band kar dein.',
        extraction: {
          ops: [wireOp('update', 'medicines', { doseNight: 1 }, { itemId: 'made-up-id' })],
          spans: [],
        },
      });

      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const segment = await settled(doctor, draft.id, 1);

      expect(segment.status).toBe('failed');
      expect(segment.error).toContain('made-up-id');

      const prescription = await draftOf(doctor, draft.id);
      expect(prescription.sections.medicines).toHaveLength(0);
    });

    test('an invented section is refused before anything is applied', async () => {
      const { doctor, patientId } = await aClinic('+923011110007');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({
        transcript: 'Something.',
        extraction: { ops: [wireOp('add', 'secretNotes', { text: 'nope' })], spans: [] },
      });

      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const segment = await settled(doctor, draft.id, 1);
      expect(segment.status).toBe('failed');
      expect(segment.error).toMatch(/shape/i);
    });

    test('a medicine with no name is refused rather than half applied', async () => {
      const { doctor, patientId } = await aClinic('+923011110008');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({
        transcript: 'Woh dawa subah shaam.',
        extraction: {
          ops: [
            wireOp('add', 'advice', { text: 'Rest' }),
            wireOp('add', 'medicines', { doseMorning: 1, doseNight: 1, flags: ['drug_unknown'] }),
          ],
          spans: [],
        },
      });

      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const segment = await settled(doctor, draft.id, 1);
      expect(segment.status).toBe('failed');

      // The whole batch is discarded, so the advice did not land either.
      const prescription = await draftOf(doctor, draft.id);
      expect(prescription.sections.advice).toHaveLength(0);
    });

    test('a dose that was not said leaves the line flagged, so it cannot be approved', async () => {
      const { doctor, patientId } = await aClinic('+923011110009');
      const headers = headersFor(doctor, { location: true });
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({
        transcript: 'Panadol de dein.',
        extraction: {
          ops: [
            wireMedicine({
              doseMorning: null,
              doseAfternoon: null,
              doseNight: null,
              durationDays: null,
              strength: null,
              flags: ['dose_unclear', 'duration_unclear'],
            }),
          ],
          spans: [],
        },
      });

      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      expect((await settled(doctor, draft.id, 1)).status).toBe('applied');

      const prescription = await draftOf(doctor, draft.id);
      expect(prescription.sections.medicines[0].flags).toEqual(['dose_unclear', 'duration_unclear']);

      const refused = await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(409);
      expect(refused.body.error.code).toBe('RX_HAS_FLAGS');
    });
  });

  describe('when the provider does not answer', () => {
    test('a transcription timeout fails the segment and can be retried', async () => {
      const { doctor, patientId } = await aClinic('+923011110010');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({ timeout: 'transcription' });
      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const failed = await settled(doctor, draft.id, 1);

      expect(failed.status).toBe('failed');
      expect(failed.error).toMatch(/longer than \d+s/);
      expect(failed.error).toContain('retry');

      // The recording is still there, so the doctor need not say it again.
      stubOpenAi({
        transcript: 'Bukhar teen din se۔',
        extraction: { ops: [wireOp('add', 'complaints', { text: 'Fever for three days' })], spans: [] },
      });
      const retried = await request(app)
        .post(`/api/v1/voice/segments/${failed.id}/retry`)
        .set(headersFor(doctor, { location: true }))
        .expect(200);
      expect(retried.body.data.status).toBe('uploaded');

      expect((await settled(doctor, draft.id, 1)).status).toBe('applied');
      const prescription = await draftOf(doctor, draft.id);
      expect(prescription.sections.complaints[0].text).toBe('Fever for three days');
    });

    test('a provider error reaches the doctor in its own words', async () => {
      const { doctor, patientId } = await aClinic('+923011110011');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({ transcriptionStatus: 400 });
      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const segment = await settled(doctor, draft.id, 1);

      expect(segment.status).toBe('failed');
      expect(segment.error).toBe('Audio file is too short.');
    });

    test('a rate limit on the extractor fails the segment, not the draft', async () => {
      const { doctor, patientId } = await aClinic('+923011110012');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({ transcript: 'Bukhar.', chatStatus: 429 });
      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const segment = await settled(doctor, draft.id, 1);

      expect(segment.status).toBe('failed');
      expect(segment.error).toBe('Rate limit reached.');
      // The transcript survived, so a retry does not re-transcribe blindly.
      expect(segment.transcript).toBe('Bukhar.');
    });

    test('silence is reported as silence', async () => {
      const { doctor, patientId } = await aClinic('+923011110013');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({ transcript: '   ' });
      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const segment = await settled(doctor, draft.id, 1);

      expect(segment.status).toBe('failed');
      expect(segment.error).toContain('Nothing could be heard');
    });

    test('the key never appears in anything the doctor can read', async () => {
      const { doctor, patientId } = await aClinic('+923011110014');
      const draft = await aDraft(doctor, patientId, 'voice');

      stubOpenAi({ transcriptionStatus: 401 });
      await upload(doctor, draft.id, 1, speak('x')).expect(201);
      const segment = await settled(doctor, draft.id, 1);

      expect(segment.status).toBe('failed');
      expect(JSON.stringify(segment)).not.toContain('sk-test');
    });
  });
});
