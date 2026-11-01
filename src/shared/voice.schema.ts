import { z } from 'zod';
import { objectIdSchema } from './common';
import { opSchema } from './prescription.schema';

export const voiceSessionStatusSchema = z.enum(['open', 'closed']);
export type VoiceSessionStatus = z.infer<typeof voiceSessionStatusSchema>;

export const segmentStatusSchema = z.enum(['uploaded', 'transcribed', 'applied', 'failed']);
export type SegmentStatus = z.infer<typeof segmentStatusSchema>;

/**
 * One stretch of speech the transcriber returned, kept so every line on the
 * prescription can be traced back to what was actually said. `isDictation`
 * marks speech aimed at the prescription, as opposed to the doctor talking to
 * the patient.
 */
export const spanSchema = z.object({
  id: z.string().min(1),
  original: z.string(),
  english: z.string(),
  lang: z.enum(['ur', 'en', 'mixed']),
  confidence: z.number().min(0).max(1),
  isDictation: z.boolean(),
});
export type Span = z.infer<typeof spanSchema>;

export const segmentAudioSchema = z.object({
  /** `practiceId/locationId/rxId/<seq>.<ext>`. Never a patient name. */
  key: z.string(),
  bytes: z.number().int().min(0),
  durationMs: z.number().int().min(0),
  deletedAt: z.coerce.date().nullable(),
});
export type SegmentAudio = z.infer<typeof segmentAudioSchema>;

export const segmentViewSchema = z.object({
  id: objectIdSchema,
  seq: z.number().int().min(1),
  status: segmentStatusSchema,
  error: z.string().nullable(),
  transcript: z.string(),
  spans: z.array(spanSchema),
  ops: z.array(opSchema),
  audio: segmentAudioSchema.omit({ key: true }).extend({ hasAudio: z.boolean() }),
  sttProvider: z.string().nullable(),
  llmModel: z.string().nullable(),
  costUsd: z.number().nullable(),
  createdAt: z.coerce.date(),
});
export type SegmentView = z.infer<typeof segmentViewSchema>;

export const voiceSessionViewSchema = z.object({
  id: objectIdSchema,
  prescriptionId: objectIdSchema,
  status: voiceSessionStatusSchema,
  segments: z.array(segmentViewSchema),
  audioDeleteAfter: z.coerce.date().nullable(),
});
export type VoiceSessionView = z.infer<typeof voiceSessionViewSchema>;

/**
 * Audio arrives base64 encoded inside the JSON body. `seq` is assigned by the
 * app and must be strictly increasing: a segment is only applied once the one
 * before it has finished, so an out-of-order upload is rejected rather than
 * silently reordered.
 */
export const addSegmentBodySchema = z.object({
  seq: z.number().int().min(1).max(10000),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .refine(
      (durationMs) => durationMs <= 30 * 60 * 1000 || durationMs >= 1_000_000_000_000,
      'Too big: expected number to be <=1800000',
    ),
  contentType: z.enum(['audio/m4a', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/webm', 'audio/mpeg']),
  audioBase64: z.string().min(1),
});
export type AddSegmentBody = z.infer<typeof addSegmentBodySchema>;

export const signedUrlViewSchema = z.object({
  url: z.string(),
  expiresAt: z.coerce.date(),
  /**
   * What is actually at that URL. Without a PDF_RENDERER_URL configured a
   * print file is stored as HTML, and an app that assumes application/pdf
   * will hand WhatsApp something it cannot share.
   */
  contentType: z.string(),
});
export type SignedUrlView = z.infer<typeof signedUrlViewSchema>;
