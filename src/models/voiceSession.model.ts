import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';
import type { Op } from '../shared/prescription.schema';
import type { SegmentStatus, Span, VoiceSessionStatus } from '../shared/voice.schema';

/**
 * One dictation session per prescription draft.
 *
 * Nothing in here writes to the prescription. A segment is transcribed, split
 * into spans, turned into `ops`, and only then does the server validate and
 * apply those ops. That is what lets a typed edit and a dictated edit share one
 * code path, and what makes every line on the page traceable to what was said.
 *
 * Segments apply strictly in `seq` order: segment 3 waits for segment 2 to be
 * 'applied' or 'failed'. A segment that stalls is timed out and marked failed,
 * because one hung transcription must not block the rest of the dictation.
 */
export interface ISegmentAudio {
  /** `practiceId/locationId/rxId/<seq>.<ext>` - never a patient name. */
  key: string;
  bytes: number;
  durationMs: number;
  deletedAt: Date | null;
}

export interface ISegment {
  _id: Types.ObjectId;
  seq: number;
  audio: ISegmentAudio;
  status: SegmentStatus;
  error: string | null;
  transcript: string;
  spans: Span[];
  ops: Op[];
  sttProvider: string | null;
  llmModel: string | null;
  costUsd: number | null;
  /** When processing began, so a stalled segment can be timed out. */
  startedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IVoiceSession {
  practiceId: Types.ObjectId;
  locationId: Types.ObjectId;
  prescriptionId: Types.ObjectId;
  doctorId: Types.ObjectId;
  status: VoiceSessionStatus;
  segments: ISegment[];
  /** When the audio may be deleted: approval + practice.settings.audioRetentionDays. */
  audioDeleteAfter: Date | null;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type VoiceSessionDoc = HydratedDocument<IVoiceSession>;

const spanSubSchema = new Schema<Span>(
  {
    id: { type: String, required: true },
    original: { type: String, default: '' },
    english: { type: String, default: '' },
    lang: { type: String, enum: ['ur', 'en', 'mixed'], default: 'mixed' },
    confidence: { type: Number, default: 0 },
    isDictation: { type: Boolean, default: true },
  },
  { _id: false },
);

const opSubSchema = new Schema(
  {
    op: { type: String, enum: ['add', 'update', 'remove'], required: true },
    section: { type: String, required: true },
    itemId: { type: String, default: null },
    value: { type: Schema.Types.Mixed, default: null },
    spanIds: { type: [String], default: [] },
  },
  { _id: false },
);

const segmentSubSchema = new Schema<ISegment>(
  {
    seq: { type: Number, required: true },
    audio: {
      key: { type: String, default: '' },
      bytes: { type: Number, default: 0 },
      durationMs: { type: Number, default: 0 },
      deletedAt: { type: Date, default: null },
    },
    status: { type: String, enum: ['uploaded', 'transcribed', 'applied', 'failed'], default: 'uploaded' },
    error: { type: String, default: null },
    transcript: { type: String, default: '' },
    spans: { type: [spanSubSchema], default: [] },
    ops: { type: [opSubSchema], default: [] },
    sttProvider: { type: String, default: null },
    llmModel: { type: String, default: null },
    costUsd: { type: Number, default: null },
    startedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

const voiceSessionSchema = new Schema<IVoiceSession>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    prescriptionId: { type: Schema.Types.ObjectId, ref: 'Prescription', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    segments: { type: [segmentSubSchema], default: [] },
    audioDeleteAfter: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

voiceSessionSchema.plugin(toJSON);

voiceSessionSchema.index({ prescriptionId: 1 }, { unique: true });
// Plain, not TTL: the sweep deletes the audio objects and stamps
// `audio.deletedAt`. The session itself is the record of what was dictated and
// stays put.
voiceSessionSchema.index({ audioDeleteAfter: 1 });

export const VoiceSession = mongoose.model<IVoiceSession>('VoiceSession', voiceSessionSchema, 'voiceSessions');
export default VoiceSession;
