import config from '../config/config';
import { AppError } from '../core/errors';

/**
 * The one place that talks to OpenAI.
 *
 * Plain fetch rather than the SDK: two endpoints are all this needs, the
 * codebase already calls the PDF renderer this way, and a test can replace
 * global fetch without a mocking framework for someone else's client.
 *
 * The key is read here and nowhere else, and never appears in a log line, a
 * response or an audit entry - a failure message carries the status and the
 * provider's own error text, both of which are safe to show a doctor.
 */
const authorization = (): string => {
  if (!config.openai.apiKey) {
    // Boot refuses this combination, so reaching here means the provider was
    // switched at runtime.
    throw new AppError('TRANSCRIPTION_FAILED', 'This server has no OpenAI key configured.');
  }
  return `Bearer ${config.openai.apiKey}`;
};

/** What OpenAI says went wrong, trimmed to something worth showing. */
const describeFailure = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    const message = body.error?.message;
    if (message) {
      return message.slice(0, 300);
    }
  } catch {
    // Not JSON; the status is all we have.
  }
  return `the transcription service answered ${response.status}`;
};

export interface OpenAiRequest {
  path: '/audio/transcriptions' | '/chat/completions';
  body: FormData | string;
  timeoutMs: number;
  /** FormData sets its own boundary, so a Content-Type must not be forced on it. */
  json?: boolean;
}

export const callOpenAi = async <T>({ path, body, timeoutMs, json }: OpenAiRequest): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${config.openai.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: authorization(),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new AppError(
      'TRANSCRIPTION_FAILED',
      timedOut
        ? `Dictation took longer than ${Math.round(timeoutMs / 1000)}s. Please retry.`
        : 'Could not reach the dictation service. Please retry.',
    );
  }

  if (!response.ok) {
    throw new AppError('TRANSCRIPTION_FAILED', await describeFailure(response));
  }

  return (await response.json()) as T;
};

/* ------------------------------------------------------------------ *
 * What it costs
 * ------------------------------------------------------------------ */

/**
 * Published rates, checked against OpenAI's pricing page in October 2026.
 *
 * Here rather than in config because they are facts about a vendor, not
 * settings for a clinic - but they do change, and a model that is not in this
 * table reports a null cost rather than a made-up one. costUsd is an estimate
 * for comparing one dictation against another, never a bill.
 */
const AUDIO_USD_PER_MINUTE: Record<string, number> = {
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'whisper-1': 0.006,
};

const TOKEN_USD_PER_MILLION: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
};

export const audioCostUsd = (model: string, durationMs: number): number | null => {
  const rate = AUDIO_USD_PER_MINUTE[model];
  if (rate === undefined) {
    return null;
  }
  return Number(((durationMs / 60_000) * rate).toFixed(6));
};

export const tokenCostUsd = (model: string, promptTokens: number, completionTokens: number): number | null => {
  const rate = TOKEN_USD_PER_MILLION[model];
  if (rate === undefined) {
    return null;
  }
  const cost = (promptTokens / 1_000_000) * rate.input + (completionTokens / 1_000_000) * rate.output;
  return Number(cost.toFixed(6));
};

export default { callOpenAi, audioCostUsd, tokenCostUsd };
