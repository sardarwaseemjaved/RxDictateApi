import { z } from 'zod';
import { dateStringSchema, objectIdSchema } from './common';
import { vitalsViewSchema } from './vitals.schema';
import { prescriptionStatusSchema } from './prescription.schema';
import { reportTypeSchema } from './report.schema';
import { visitStatusSchema } from './visit.schema';

/**
 * A patient's timeline, newest first.
 *
 * A union discriminated by `kind` rather than four parallel lists, because the
 * History tab renders one chronological column: what happened to this person,
 * in order. Four lists would make the app merge and sort them, and get a
 * different answer from the server about what "newest" means.
 *
 * Settled now and served later: GET /patients/:id/history still answers 501,
 * so the app can be written against these shapes while the endpoint is built.
 */
export const historyVisitSchema = z.object({
  kind: z.literal('visit'),
  id: objectIdSchema,
  at: z.coerce.date(),
  locationId: objectIdSchema,
  date: dateStringSchema,
  token: z.number().int(),
  reason: z.string(),
  status: visitStatusSchema,
  /** Null when nobody recorded any. */
  vitals: vitalsViewSchema.nullable(),
});
export type HistoryVisit = z.infer<typeof historyVisitSchema>;

export const historyPrescriptionSchema = z.object({
  kind: z.literal('prescription'),
  id: objectIdSchema,
  at: z.coerce.date(),
  number: z.string().nullable(),
  version: z.number().int(),
  status: prescriptionStatusSchema,
  /** Enough to read the line in a timeline without opening it. */
  diagnosis: z.array(z.string()),
  medicineNames: z.array(z.string()),
  hasPdf: z.boolean(),
});
export type HistoryPrescription = z.infer<typeof historyPrescriptionSchema>;

export const historyLabSchema = z.object({
  kind: z.literal('lab'),
  id: objectIdSchema,
  at: z.coerce.date(),
  name: z.string(),
  /** Empty until somebody enters it. */
  result: z.string(),
  /** The prescription that ordered it, when one did. */
  prescriptionId: objectIdSchema.nullable(),
  hasFile: z.boolean(),
});
export type HistoryLab = z.infer<typeof historyLabSchema>;

export const historyReportSchema = z.object({
  kind: z.literal('report'),
  id: objectIdSchema,
  at: z.coerce.date(),
  type: reportTypeSchema,
  testName: z.string(),
  testDate: dateStringSchema,
  pages: z.number().int().min(1),
  reviewedAt: z.coerce.date().nullable(),
});
export type HistoryReport = z.infer<typeof historyReportSchema>;

export const historyItemViewSchema = z.discriminatedUnion('kind', [
  historyVisitSchema,
  historyPrescriptionSchema,
  historyLabSchema,
  historyReportSchema,
]);
export type HistoryItemView = z.infer<typeof historyItemViewSchema>;

export const historyKindSchema = z.enum(['visit', 'prescription', 'lab', 'report']);
export type HistoryKind = z.infer<typeof historyKindSchema>;

export const listHistoryQuerySchema = z.object({
  /** Narrow the timeline to one kind, for the tab's filter chips. */
  kind: historyKindSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListHistoryQuery = z.infer<typeof listHistoryQuerySchema>;
