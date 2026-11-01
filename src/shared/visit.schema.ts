import { z } from 'zod';
import { dateStringSchema, objectIdSchema } from './common';
import { patientViewSchema } from './patient.schema';

export const visitStatusSchema = z.enum(['waiting', 'with_doctor', 'done']);
export type VisitStatus = z.infer<typeof visitStatusSchema>;

export const visitViewSchema = z.object({
  id: objectIdSchema,
  locationId: objectIdSchema,
  patientId: objectIdSchema,
  patient: patientViewSchema.nullable(),
  /** The Karachi calendar day the patient is on the list for. */
  date: dateStringSchema,
  /**
   * The number called out in the waiting room. Starts at 1 each day at each
   * location, and is never reused - a removed visit takes its token with it,
   * because the patient holding that slip has already heard it.
   */
  token: z.number().int().min(1),
  /**
   * The visit's place in its day's list at its location: sort by it, smallest
   * first. Not a count and not gap-free - a moved visit lands between its new
   * neighbours, so 2.5 is an ordinary value - and never shown. The token is
   * what a patient hears; this is only the order the assistant chose.
   */
  queuePosition: z.number(),
  /** Why they came, in the PA's words: "Fever 3 days". */
  reason: z.string(),
  /** When the visit entered its current status, for "went in 6 min ago". */
  statusChangedAt: z.coerce.date(),
  /** Null until vitals are saved. Drives "Vitals done" against "Add vitals". */
  vitalsRecordedAt: z.coerce.date().nullable(),
  status: visitStatusSchema,
  createdAt: z.coerce.date(),
});
export type VisitView = z.infer<typeof visitViewSchema>;

export const createVisitBodySchema = z.object({
  patientId: objectIdSchema,
  /** Defaults to today in Asia/Karachi, which is what the PA almost always wants. */
  date: dateStringSchema.optional(),
  reason: z.string().trim().max(500).default(''),
});
export type CreateVisitBody = z.infer<typeof createVisitBodySchema>;

export const updateVisitBodySchema = z.object({
  status: visitStatusSchema,
});
export type UpdateVisitBody = z.infer<typeof updateVisitBodySchema>;

/**
 * Where a waiting visit goes: just before the visit `before`, or after every
 * other waiting visit when it is null. Relative rather than a number, so two
 * people rearranging at once each get what they asked for instead of one
 * overwriting the other's arithmetic.
 */
export const moveVisitBodySchema = z.object({
  before: objectIdSchema.nullable(),
});
export type MoveVisitBody = z.infer<typeof moveVisitBodySchema>;

/** `date` accepts the literal `today`, resolved against Asia/Karachi. */
export const listVisitsQuerySchema = z.object({
  date: z.union([z.literal('today'), dateStringSchema]).default('today'),
  status: visitStatusSchema.optional(),
});
export type ListVisitsQuery = z.infer<typeof listVisitsQuerySchema>;
