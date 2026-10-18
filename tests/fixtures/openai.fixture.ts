import config from '../../src/config/config';

/**
 * Recorded OpenAI answers, replayed through a stubbed fetch.
 *
 * No test here ever reaches the network: a suite that spends money and fails
 * when somebody's key expires is a suite people learn to ignore. The shapes
 * are the ones the API actually returns, so the parsing is still under test.
 */
export interface RecordedCall {
  url: string;
  body: string | FormData;
  headers: Record<string, string>;
}

export interface OpenAiStub {
  calls: RecordedCall[];
  /** The transcription request, parsed out of its multipart body. */
  transcriptionForm: () => FormData;
  chatRequest: () => Record<string, unknown>;
}

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

export interface StubAnswers {
  /** The transcript the audio comes back as. */
  transcript?: string;
  /** The ops and span annotations the extractor replies with. */
  extraction?: { ops: unknown[]; spans: unknown[] };
  /** Replace either answer with a failure. */
  transcriptionStatus?: number;
  chatStatus?: number;
  /** Make the matching call time out instead of answering. */
  timeout?: 'transcription' | 'chat';
  usage?: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Point the providers at a stubbed fetch for one test.
 *
 * Restoring is left to jest's restoreMocks, which jest.config.js turns on.
 */
export const stubOpenAi = (answers: StubAnswers = {}): OpenAiStub => {
  config.voice.sttProvider = 'openai';
  config.voice.llmProvider = 'openai';
  config.openai.apiKey = 'sk-test-not-a-real-key';

  const stub: OpenAiStub = {
    calls: [],
    transcriptionForm: () => {
      const call = stub.calls.find((candidate) => candidate.url.includes('/audio/transcriptions'));
      if (!call || typeof call.body === 'string') throw new Error('no transcription call was made');
      return call.body;
    },
    chatRequest: () => {
      const call = stub.calls.find((candidate) => candidate.url.includes('/chat/completions'));
      if (!call || typeof call.body !== 'string') throw new Error('no chat call was made');
      return JSON.parse(call.body) as Record<string, unknown>;
    },
  };

  jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const request = init ?? {};
    stub.calls.push({
      url,
      body: request.body as string | FormData,
      headers: (request.headers ?? {}) as Record<string, string>,
    });

    if (url.includes('/audio/transcriptions')) {
      if (answers.timeout === 'transcription') {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      if (answers.transcriptionStatus) {
        return jsonResponse({ error: { message: 'Audio file is too short.' } }, answers.transcriptionStatus);
      }
      return jsonResponse({ text: answers.transcript ?? 'Bukhar teen din se.' });
    }

    if (url.includes('/chat/completions')) {
      if (answers.timeout === 'chat') {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      if (answers.chatStatus) {
        return jsonResponse({ error: { message: 'Rate limit reached.' } }, answers.chatStatus);
      }
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(answers.extraction ?? { ops: [], spans: [] }) } }],
        usage: answers.usage ?? { prompt_tokens: 900, completion_tokens: 120 },
      });
    }

    throw new Error(`unexpected call to ${url}`);
  });

  return stub;
};

/** Put the providers back, since config is a module-level object. */
export const unstubOpenAi = (): void => {
  config.voice.sttProvider = 'mock';
  config.voice.llmProvider = 'mock';
  config.openai.apiKey = undefined;
};

/** A medicine op as the extractor sends it, before the server narrows it. */
export const wireMedicine = (overrides: Record<string, unknown> = {}) => ({
  op: 'add',
  section: 'medicines',
  itemId: null,
  spanIds: [],
  value: {
    text: null,
    code: null,
    name: 'Panadol',
    strength: '500mg',
    form: 'tab',
    route: 'oral',
    timing: 'after_meal',
    doseMorning: 1,
    doseAfternoon: 0,
    doseNight: 1,
    asNeeded: null,
    durationDays: 5,
    instructionEn: null,
    instructionUr: null,
    flags: [],
    inDays: null,
    date: null,
    note: null,
    ...overrides,
  },
});

/** Any other op, with every field the schema requires present and null. */
export const wireOp = (
  op: string,
  section: string,
  value: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  op,
  section,
  itemId: null,
  spanIds: [],
  ...extra,
  value: {
    text: null,
    code: null,
    name: null,
    strength: null,
    form: null,
    route: null,
    timing: null,
    doseMorning: null,
    doseAfternoon: null,
    doseNight: null,
    asNeeded: null,
    durationDays: null,
    instructionEn: null,
    instructionUr: null,
    flags: [],
    inDays: null,
    date: null,
    note: null,
    ...value,
  },
});
