import config from '../config/config';
import { AppError } from '../core/errors';
import type { Span } from '../shared/voice.schema';
import { newSpanId } from '../utils/ids';

export interface Transcription {
  transcript: string;
  spans: Span[];
  provider: string;
  costUsd: number | null;
}

/** Urdu, Arabic and Persian share a block; anything in it is not English. */
const hasUrdu = (text: string): boolean => /[؀-ۿ]/.test(text);

const classify = (text: string): Span['lang'] => {
  const urdu = hasUrdu(text);
  const latin = /[A-Za-z]/.test(text);
  if (urdu && latin) return 'mixed';
  return urdu ? 'ur' : 'en';
};

/**
 * Speech to text for mixed Urdu and English dictation.
 *
 * A provider seam rather than a provider. Which transcriber to use is a
 * decision about accuracy on Pakistani code-switched speech and about where
 * patient audio is allowed to go, and it is not this file's to make. What is
 * fixed here is the contract: audio in, a transcript and spans out, with every
 * span keeping the original alongside its English so a line on the prescription
 * can always be traced to what was actually said.
 *
 * 'none' is the default and fails the segment with a clear error rather than
 * pretending. 'mock' reads the upload as UTF-8 text, which is what lets the
 * whole pipeline - ordering, validation, apply, audit - be exercised without a
 * provider.
 */
export const transcribe = async (audio: Buffer, _contentType: string): Promise<Transcription> => {
  if (config.voice.sttProvider === 'none') {
    throw new AppError('TRANSCRIPTION_FAILED', 'No speech-to-text provider is configured on this server.');
  }

  const text = audio.toString('utf8').trim();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    transcript: text,
    spans: lines.map((line) => ({
      id: newSpanId(),
      original: line,
      english: line,
      lang: classify(line),
      confidence: 1,
      // Everything in a mock upload is meant for the prescription. A real
      // provider has to decide this, because a doctor also talks to the patient.
      isDictation: true,
    })),
    provider: `mock-stt`,
    costUsd: 0,
  };
};

export default { transcribe };
