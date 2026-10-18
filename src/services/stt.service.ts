import config from '../config/config';
import { AppError } from '../core/errors';
import { extensionFor } from '../core/storage';
import type { Span } from '../shared/voice.schema';
import { newSpanId } from '../utils/ids';
import { audioCostUsd, callOpenAi } from './openai.client';

export interface Transcription {
  transcript: string;
  spans: Span[];
  provider: string;
  costUsd: number | null;
}

/** What is already on the draft, so brand names come back spelled right. */
export interface TranscribeContext {
  drugNames?: string[];
  durationMs?: number;
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
 * Break a transcript into the pieces a line on the prescription can be traced
 * back to.
 *
 * Sentence enders plus the Urdu full stop and comma, which is where a clause
 * ends in dictated Urdu. The ASCII comma is deliberately left out: it splits
 * "1,000" and buys nothing here.
 */
const toSpans = (transcript: string): Span[] =>
  transcript
    .split(/(?<=[.!?؟۔،])\s+|\n+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
    .map((piece) => ({
      id: newSpanId(),
      original: piece,
      /**
       * Both filled properly by the extraction step, which sees the whole
       * transcript and can tell an aside to the patient from an instruction.
       * Until then the original stands in, and nothing is thrown away.
       */
      english: piece,
      lang: classify(piece),
      /**
       * The transcription API returns no per-span score, so this is not a
       * measurement. The medicine flags are what actually carry "the pipeline
       * was unsure about this line".
       */
      confidence: 1,
      isDictation: true,
    }));

/**
 * Tell the transcriber what it is listening to.
 *
 * Pakistani clinical dictation switches language inside a sentence - "bukhar
 * teen din se, Panadol one tablet subah shaam" - and a transcriber told to
 * expect one language will force the other into it. The drug names already on
 * the draft go in too, because a brand name is exactly the word a general
 * model gets wrong and exactly the word that must be right.
 */
const transcriptionPrompt = (drugNames: string[]): string => {
  const base =
    'Pakistani medical dictation by a doctor. The speaker mixes Urdu and English freely within a sentence, ' +
    'including romanised Urdu. Transcribe what was said, in the language and script it was said in. ' +
    'Keep medicine brand names, strengths and dose words exactly as spoken.';

  const names = [...new Set(drugNames.map((name) => name.trim()).filter(Boolean))].slice(0, 60);
  return names.length > 0 ? `${base} Medicines that may be mentioned: ${names.join(', ')}.` : base;
};

interface OpenAiTranscription {
  text?: string;
}

/**
 * Speech to text for mixed Urdu and English dictation.
 *
 * `none` is the default and fails the segment with a clear error rather than
 * pretending. `mock` reads the upload as UTF-8 text, which is what lets the
 * ordering, validation, apply and audit path be exercised without a provider.
 * `openai` is the real one.
 */
export const transcribe = async (
  audio: Buffer,
  contentType: string,
  context: TranscribeContext = {},
): Promise<Transcription> => {
  if (config.voice.sttProvider === 'none') {
    throw new AppError('TRANSCRIPTION_FAILED', 'No speech-to-text provider is configured on this server.');
  }

  if (config.voice.sttProvider === 'openai') {
    const form = new FormData();
    // OpenAI reads the audio format from the filename, so the extension has to
    // match what was actually recorded.
    form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), `segment.${extensionFor(contentType)}`);
    form.append('model', config.openai.sttModel);
    form.append('prompt', transcriptionPrompt(context.drugNames ?? []));
    // No `language`: fixing one would flatten the code-switching this is for.
    form.append('response_format', 'json');

    const answer = await callOpenAi<OpenAiTranscription>({
      path: '/audio/transcriptions',
      body: form,
      // Most of the segment's budget, leaving room for the extraction step.
      timeoutMs: Math.round(config.voice.segmentTimeoutMs * 0.6),
    });

    const transcript = (answer.text ?? '').trim();
    if (transcript === '') {
      throw new AppError('TRANSCRIPTION_FAILED', 'Nothing could be heard in that recording. Please try again.');
    }

    return {
      transcript,
      spans: toSpans(transcript),
      provider: config.openai.sttModel,
      costUsd: audioCostUsd(config.openai.sttModel, context.durationMs ?? 0),
    };
  }

  const text = audio.toString('utf8').trim();
  return {
    transcript: text,
    spans: toSpans(text),
    provider: 'mock-stt',
    costUsd: 0,
  };
};

export default { transcribe };
