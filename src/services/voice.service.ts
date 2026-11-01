import { Types } from 'mongoose';
import config from '../config/config';
import logger from '../config/logger';
import {
  Practice,
  Prescription,
  VoiceSession,
  type ISegment,
  type IVoiceSession,
  type PrescriptionDoc,
  type VoiceSessionDoc,
} from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import { audioKey, extensionFor, get as getObject, put, remove, signedGetUrl } from '../core/storage';
import type { AddSegmentBody, SegmentView, SignedUrlView, VoiceSessionView } from '../shared/voice.schema';
import { applyOps, wireSections } from './prescriptionOps.service';
import { extractOps } from './llm.service';
import { transcribe } from './stt.service';

const sessions = new BaseRepository<IVoiceSession>(VoiceSession, { locationScoped: true });

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  m4a: 'audio/m4a',
  aac: 'audio/aac',
  wav: 'audio/wav',
  webm: 'audio/webm',
  mp3: 'audio/mpeg',
};

const LEGACY_ANDROID_DURATION_MIN = 1_000_000_000_000;
const MAX_SEGMENT_DURATION_MS = 30 * 60 * 1000;
const LEGACY_APP_AUDIO_BIT_RATE = 64_000;

/**
 * expo-audio 1.1.x exposes Android recorder.currentTime as its epoch start
 * timestamp. An older app multiplied that by 1000 and sent it as durationMs.
 * Recognise only that impossible timestamp-shaped value and approximate the
 * elapsed time from the old app's fixed 64 kbps AAC setting. Normal oversized
 * durations still fail request validation.
 */
const normalizedDurationMs = (supplied: number, audioBytes: number): number => {
  if (supplied < LEGACY_ANDROID_DURATION_MIN) return supplied;
  const estimated = Math.round((audioBytes * 8 * 1000) / LEGACY_APP_AUDIO_BIT_RATE);
  return Math.min(MAX_SEGMENT_DURATION_MS, Math.max(1000, estimated));
};

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

const toSegmentView = (segment: ISegment): SegmentView => ({
  id: String(segment._id),
  seq: segment.seq,
  status: segment.status,
  error: segment.error,
  transcript: segment.transcript,
  spans: segment.spans,
  ops: segment.ops,
  // The key is not handed out: the app asks for a signed URL instead.
  audio: {
    bytes: segment.audio.bytes,
    durationMs: segment.audio.durationMs,
    deletedAt: segment.audio.deletedAt,
    hasAudio: segment.audio.deletedAt === null && segment.audio.key !== '',
  },
  sttProvider: segment.sttProvider,
  llmModel: segment.llmModel,
  costUsd: segment.costUsd,
  createdAt: segment.createdAt,
});

const toSessionView = (session: VoiceSessionDoc): VoiceSessionView => ({
  id: String(session._id),
  prescriptionId: String(session.prescriptionId),
  status: session.status,
  segments: [...session.segments].sort((a, b) => a.seq - b.seq).map(toSegmentView),
  audioDeleteAfter: session.audioDeleteAfter,
});

/* ------------------------------------------------------------------ *
 * The pipeline
 * ------------------------------------------------------------------ */

/**
 * One segment at a time per session, in this process.
 *
 * In-process and deliberately so: a queue is the right answer when load asks
 * for one, and until then this is one fewer moving part. The consequence is
 * recorded honestly - this set does not survive a restart, which is what the
 * stalled-segment sweep below is for.
 */
const processing = new Set<string>();

/**
 * A segment that never finishes must not hold up the rest of the dictation.
 *
 * The losing promise is not cancelled, because neither an HTTP call nor an SDK
 * call can be, so the work may still complete into nothing. What matters is
 * that the queue moves on and the doctor is told.
 */
const withTimeout = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AppError('TRANSCRIPTION_FAILED', `${what} did not finish within ${Math.round(ms / 1000)}s`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const scopeOf = (session: VoiceSessionDoc): Scope => ({
  practiceId: session.practiceId,
  actorId: session.doctorId,
  role: 'doctor',
  allowedLocationIds: 'all',
  locationId: session.locationId,
});

const segmentIndex = (session: VoiceSessionDoc, segmentId: Types.ObjectId): number =>
  session.segments.findIndex((segment) => String(segment._id) === String(segmentId));

/**
 * Transcribe one segment, turn it into ops, and let the server apply them.
 *
 * Voice never writes to a prescription. It gets as far as `ops`, and
 * prescriptionOps validates and applies them - the same function a typed edit
 * goes through. An extractor that returns something the server will not accept
 * fails the segment and leaves the draft exactly as it was.
 */
const runSegment = async (session: VoiceSessionDoc, segmentId: Types.ObjectId): Promise<void> => {
  const index = segmentIndex(session, segmentId);
  const segment = session.segments[index];
  const sessionId = String(session._id);
  const id = String(segmentId);

  logger.info(`[voice] processing started sessionId=${sessionId} segmentId=${id} seq=${segment.seq}`);

  const extension = segment.audio.key.split('.').pop() ?? 'm4a';
  const audio = await getObject(segment.audio.key);
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension] ?? 'audio/m4a';
  logger.info(
    `[voice] transcription started sessionId=${sessionId} segmentId=${id} provider=${config.voice.sttProvider} ` +
      `model=${config.openai.sttModel} bytes=${audio.length} durationMs=${segment.audio.durationMs} ` +
      `contentType=${contentType}`,
  );

  const prescription = await Prescription.findOne({ _id: session.prescriptionId, deletedAt: null });
  if (!prescription) {
    throw AppError.notFound('Prescription');
  }
  if (prescription.status !== 'draft') {
    throw new AppError('VOICE_SESSION_CLOSED', 'That prescription is no longer a draft.');
  }
  const sections = wireSections(prescription.sections);

  const transcription = await transcribe(audio, contentType, {
    // A brand name is the word a general model gets wrong and the word that
    // has to be right, so what is already on the draft is given to it.
    drugNames: sections.medicines.map((medicine) => medicine.name),
    durationMs: segment.audio.durationMs,
  });
  segment.transcript = transcription.transcript;
  segment.spans = transcription.spans;
  segment.sttProvider = transcription.provider;
  segment.costUsd = transcription.costUsd;
  segment.status = 'transcribed';
  session.markModified('segments');
  await session.save();
  logger.info(
    `[voice] transcription completed sessionId=${sessionId} segmentId=${id} model=${transcription.provider} ` +
      `transcriptChars=${transcription.transcript.length} spans=${transcription.spans.length} ` +
      `costUsd=${transcription.costUsd ?? 'unknown'}`,
  );

  logger.info(
    `[voice] extraction started sessionId=${sessionId} segmentId=${id} provider=${config.voice.llmProvider} ` +
      `model=${config.openai.model}`,
  );

  const extraction = await extractOps({
    transcript: transcription.transcript,
    spans: transcription.spans,
    sections,
  });

  /**
   * The extractor decides the English rendering and whether a span was
   * dictation or the doctor talking to the patient: it has read the whole
   * transcript, where the transcriber saw one clause at a time. The original
   * is never touched, so a line can always be traced to what was actually
   * said.
   */
  const annotations = new Map(extraction.spans.map((span) => [span.id, span]));
  segment.spans = segment.spans.map((span) => {
    const annotation = annotations.get(span.id);
    return annotation
      ? { ...span, english: annotation.english || span.original, isDictation: annotation.isDictation }
      : span;
  });

  segment.ops = extraction.ops;
  segment.llmModel = extraction.model;
  segment.costUsd = (segment.costUsd ?? 0) + (extraction.costUsd ?? 0);
  logger.info(
    `[voice] extraction completed sessionId=${sessionId} segmentId=${id} model=${extraction.model} ` +
      `ops=${extraction.ops.length} annotations=${extraction.spans.length} ` +
      `totalCostUsd=${segment.costUsd ?? 'unknown'}`,
  );

  // Applied to the sections as they are now, not the copy the extractor was
  // shown: an earlier segment may have landed while this one was in flight.
  const applied = applyOps(wireSections(prescription.sections), extraction.ops, {
    actorId: session.doctorId,
    origin: 'voice',
  });
  prescription.set('sections', applied.sections);
  // A draft the doctor has already typed into and then dictated over is both.
  prescription.source = prescription.editLog.length > 0 ? 'mixed' : 'voice';
  await prescription.save();

  segment.status = 'applied';
  segment.error = null;
  session.markModified('segments');
  await session.save();
  logger.info(
    `[voice] segment applied sessionId=${sessionId} segmentId=${id} prescriptionId=${String(
      prescription._id,
    )} seq=${segment.seq} ops=${extraction.ops.length}`,
  );

  await writeAudit(scopeOf(session), {
    action: 'voice.segmentApplied',
    entity: 'prescription',
    entityId: prescription._id,
    after: { seq: segment.seq, ops: extraction.ops.length, segmentId: String(segment._id) },
  });
  emit('voice.segmentApplied', {
    practiceId: session.practiceId,
    prescriptionId: prescription._id,
    segmentId: segment._id,
    seq: segment.seq,
    opCount: extraction.ops.length,
  });
};

const failSegment = async (session: VoiceSessionDoc, segmentId: Types.ObjectId, error: Error): Promise<void> => {
  const fresh = await VoiceSession.findById(session._id);
  if (!fresh) return;

  const index = segmentIndex(fresh, segmentId);
  if (index < 0) return;

  const segment = fresh.segments[index];
  segment.status = 'failed';
  segment.error = error.message;
  fresh.markModified('segments');
  await fresh.save();

  const code = error instanceof AppError ? error.code : 'UNEXPECTED';
  logger.warn(
    `[voice] segment failed sessionId=${String(fresh._id)} segmentId=${String(segmentId)} seq=${segment.seq} ` +
      `code=${code} error=${error.message}`,
  );

  emit('voice.segmentFailed', {
    practiceId: fresh.practiceId,
    prescriptionId: fresh.prescriptionId,
    segmentId,
    seq: segment.seq,
    doctorId: fresh.doctorId,
    error: error.message,
  });
};

/**
 * A segment whose processing began but never finished - because the process
 * restarted, or because a provider hung in a way the timeout could not see.
 * Marked failed so the queue behind it moves.
 */
export const sweepStalledSegments = async (): Promise<number> => {
  const cutoff = new Date(Date.now() - config.voice.segmentTimeoutMs);
  const stalled = await VoiceSession.find({
    segments: { $elemMatch: { status: { $in: ['uploaded', 'transcribed'] }, startedAt: { $ne: null, $lt: cutoff } } },
  });

  let count = 0;
  // Sequential on purpose: each failSegment re-reads and saves its session, so
  // running them at once would have them overwrite each other.
  for (let i = 0; i < stalled.length; i += 1) {
    const session = stalled[i];
    const due = session.segments.filter(
      (segment) =>
        (segment.status === 'uploaded' || segment.status === 'transcribed') &&
        segment.startedAt !== null &&
        segment.startedAt < cutoff,
    );
    for (let j = 0; j < due.length; j += 1) {
      // eslint-disable-next-line no-await-in-loop
      await failSegment(session, due[j]._id, new Error('processing stalled and was timed out'));
      count += 1;
    }
  }
  if (count > 0) {
    logger.warn(`timed out ${count} stalled dictation segment(s)`);
  }
  return count;
};

/**
 * Work through a session's segments in `seq` order: segment 3 waits for segment
 * 2 to be applied or failed. Returns as soon as there is nothing ready, and is
 * started again by the next upload or retry.
 */
const processSession = async (sessionId: Types.ObjectId): Promise<void> => {
  const key = String(sessionId);
  if (processing.has(key)) {
    return;
  }
  processing.add(key);

  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const session = await VoiceSession.findById(sessionId);
      if (!session) return;

      const ordered = [...session.segments].sort((a, b) => a.seq - b.seq);
      const next = ordered.find((segment) => segment.status === 'uploaded');
      if (!next) return;

      const blocked = ordered.some(
        (segment) => segment.seq < next.seq && segment.status !== 'applied' && segment.status !== 'failed',
      );
      if (blocked) return;

      const index = segmentIndex(session, next._id);
      session.segments[index].startedAt = new Date();
      session.markModified('segments');
      // eslint-disable-next-line no-await-in-loop
      await session.save();

      try {
        // eslint-disable-next-line no-await-in-loop
        await withTimeout(runSegment(session, next._id), config.voice.segmentTimeoutMs, `segment ${next.seq}`);
      } catch (error) {
        // eslint-disable-next-line no-await-in-loop
        await failSegment(session, next._id, error as Error);
      }
    }
  } finally {
    processing.delete(key);
  }
};

/** Kick the queue without making the caller wait for a transcription. */
const kick = (sessionId: Types.ObjectId): void => {
  processSession(sessionId).catch((error: Error) => {
    logger.error(`voice session ${String(sessionId)} failed: ${error.message}`);
  });
};

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

const loadDraft = async (scope: Scope, prescriptionId: string): Promise<PrescriptionDoc> => {
  const prescription = await Prescription.findOne({
    _id: prescriptionId,
    practiceId: scope.practiceId,
    ...(scope.locationId ? { locationId: scope.locationId } : {}),
    deletedAt: null,
  });
  if (!prescription) {
    throw AppError.notFound('Prescription');
  }
  return prescription;
};

const getOrCreateSession = async (scope: Scope, prescription: PrescriptionDoc): Promise<VoiceSessionDoc> => {
  const existing = await sessions.findOne(scope, { prescriptionId: prescription._id });
  if (existing) {
    return existing;
  }
  try {
    return await sessions.create(scope, {
      prescriptionId: prescription._id,
      doctorId: prescription.doctorId,
      status: 'open',
      segments: [],
    });
  } catch (error) {
    // The screen query and the upload can arrive together. The unique
    // prescriptionId index decides which creates the session; the loser reads
    // the winner instead of surfacing a duplicate-key error to the app.
    if ((error as { code?: number }).code === 11000) {
      const raced = await sessions.findOne(scope, { prescriptionId: prescription._id });
      if (raced) return raced;
    }
    throw error;
  }
};

/**
 * Take one stretch of dictation.
 *
 * `seq` has to be exactly one more than the last segment: an upload that skips
 * ahead is refused rather than quietly reordered, because the ops of segment 3
 * can refer to a line that segment 2 was about to add.
 */
export const addSegment = async (scope: Scope, prescriptionId: string, body: AddSegmentBody): Promise<SegmentView> => {
  const practice = await Practice.findById(scope.practiceId);
  if (!practice?.features.voice) {
    throw new AppError('FEATURE_DISABLED', 'Dictation is switched off for this clinic.');
  }

  const prescription = await loadDraft(scope, prescriptionId);
  if (prescription.status !== 'draft') {
    throw new AppError('RX_LOCKED', 'That prescription is approved. Revise it before dictating again.');
  }

  const session = await getOrCreateSession(scope, prescription);
  if (session.status === 'closed') {
    throw new AppError('VOICE_SESSION_CLOSED', 'That dictation session is closed.');
  }

  const highest = session.segments.reduce((max, segment) => Math.max(max, segment.seq), 0);
  if (body.seq <= highest) {
    throw new AppError('SEGMENT_DUPLICATE', `Segment ${body.seq} has already been uploaded.`);
  }
  if (body.seq !== highest + 1) {
    throw new AppError('SEGMENT_OUT_OF_ORDER', `Expected segment ${highest + 1}, not ${body.seq}.`);
  }

  const audio = Buffer.from(body.audioBase64, 'base64');
  if (audio.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'That audio is empty.');
  }
  if (audio.length > config.storage.maxAudioBytes) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Audio is limited to ${Math.round(config.storage.maxAudioBytes / 1024 / 1024)}MB.`,
    );
  }

  const durationMs = normalizedDurationMs(body.durationMs, audio.length);
  if (durationMs !== body.durationMs) {
    logger.warn(
      `[voice] corrected legacy Android duration prescriptionId=${String(prescription._id)} ` +
        `suppliedMs=${body.durationMs} estimatedMs=${durationMs} bytes=${audio.length}`,
    );
  }

  const key = audioKey(scope.practiceId, session.locationId, prescription._id, body.seq, extensionFor(body.contentType));
  await put(key, audio, body.contentType);

  session.segments.push({
    seq: body.seq,
    audio: { key, bytes: audio.length, durationMs, deletedAt: null },
    status: 'uploaded',
    error: null,
    transcript: '',
    spans: [],
    ops: [],
    sttProvider: null,
    llmModel: null,
    costUsd: null,
    startedAt: null,
  } as unknown as ISegment);
  await session.save();

  const stored = session.segments[session.segments.length - 1];

  logger.info(
    `[voice] upload accepted sessionId=${String(session._id)} segmentId=${String(stored._id)} ` +
      `prescriptionId=${String(prescription._id)} seq=${stored.seq} bytes=${audio.length}; queued for processing`,
  );

  await writeAudit(scope, {
    action: 'voice.segmentUploaded',
    entity: 'prescription',
    entityId: prescription._id,
    after: { seq: body.seq, bytes: audio.length, durationMs },
  });

  // Transcription runs in the background and the app polls GET .../voice.
  kick(session._id);

  return toSegmentView(stored);
};

export const getVoiceSession = async (scope: Scope, prescriptionId: string): Promise<VoiceSessionView> => {
  const prescription = await loadDraft(scope, prescriptionId);
  const session = await getOrCreateSession(scope, prescription);
  return toSessionView(session);
};

const findSessionBySegment = async (scope: Scope, segmentId: string): Promise<VoiceSessionDoc> => {
  const session = await sessions.findOne(scope, { 'segments._id': new Types.ObjectId(segmentId) });
  if (!session) {
    throw AppError.notFound('Dictation segment');
  }
  return session;
};

/** A failed segment can be put back in the queue without re-recording it. */
export const retrySegment = async (scope: Scope, segmentId: string): Promise<SegmentView> => {
  const session = await findSessionBySegment(scope, segmentId);
  const index = segmentIndex(session, new Types.ObjectId(segmentId));
  const segment = session.segments[index];

  if (segment.status === 'applied') {
    throw new AppError('CONFLICT', 'That segment has already been applied.');
  }
  if (segment.audio.deletedAt !== null) {
    throw new AppError('NOT_FOUND', 'That recording has been deleted and cannot be retried.');
  }

  segment.status = 'uploaded';
  segment.error = null;
  segment.startedAt = null;
  session.markModified('segments');
  await session.save();

  logger.info(`[voice] retry queued sessionId=${String(session._id)} segmentId=${String(segment._id)} seq=${segment.seq}`);

  kick(session._id);
  return toSegmentView(session.segments[index]);
};

export const segmentAudioUrl = async (scope: Scope, segmentId: string): Promise<SignedUrlView> => {
  const session = await findSessionBySegment(scope, segmentId);
  const segment = session.segments[segmentIndex(session, new Types.ObjectId(segmentId))];

  if (segment.audio.deletedAt !== null || !segment.audio.key) {
    throw new AppError('NOT_FOUND', 'That recording has been deleted.');
  }

  return signedGetUrl(segment.audio.key);
};

/**
 * Delete dictation audio once its retention has run out.
 *
 * The session and the transcript stay: they are the record of what was
 * dictated. Only the recording goes, which is the part that is a patient's
 * voice.
 */
export const sweepExpiredAudio = async (now: Date = new Date()): Promise<number> => {
  const due = await VoiceSession.find({ audioDeleteAfter: { $ne: null, $lte: now } });

  let deleted = 0;
  for (let i = 0; i < due.length; i += 1) {
    const session = due[i];
    const withAudio = session.segments.filter((segment) => segment.audio.key !== '' && segment.audio.deletedAt === null);

    // eslint-disable-next-line no-await-in-loop
    await Promise.all(withAudio.map((segment) => remove(segment.audio.key)));
    // Stamped through the document rather than on the filtered copies, so
    // mongoose sees the change.
    session.segments.forEach((segment, index) => {
      if (withAudio.some((pending) => String(pending._id) === String(segment._id))) {
        session.segments[index].audio.deletedAt = now;
      }
    });

    if (withAudio.length > 0) {
      session.markModified('segments');
      // eslint-disable-next-line no-await-in-loop
      await session.save();
      deleted += withAudio.length;
    }
  }

  if (deleted > 0) {
    logger.info(`deleted ${deleted} expired dictation recording(s)`);
  }
  return deleted;
};

export default {
  addSegment,
  getVoiceSession,
  retrySegment,
  segmentAudioUrl,
  sweepExpiredAudio,
  sweepStalledSegments,
};
