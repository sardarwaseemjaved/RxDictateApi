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
  status: visitStatusSchema,
  createdAt: z.coerce.date(),
});
export type VisitView = z.infer<typeof visitViewSchema>;

export const createVisitBodySchema = z.object({
  patientId: objectIdSchema,
  /** Defaults to today in Asia/Karachi, which is what the PA almost always wants. */
  date: dateStringSchema.optional(),
});
export type CreateVisitBody = z.infer<typeof createVisitBodySchema>;

export const updateVisitBodySchema = z.object({
  status: visitStatusSchema,
});
export type UpdateVisitBody = z.infer<typeof updateVisitBodySchema>;

/** `date` accepts the literal `today`, resolved against Asia/Karachi. */
export const listVisitsQuerySchema = z.object({
  date: z.union([z.literal('today'), dateStringSchema]).default('today'),
  status: visitStatusSchema.optional(),
});
export type ListVisitsQuery = z.infer<typeof listVisitsQuerySchema>;
