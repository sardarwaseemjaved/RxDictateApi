import { z } from 'zod';
import { bilingualSchema, dateStringSchema, objectIdSchema, timingSchema } from './common';

export const prescriptionStatusSchema = z.enum(['draft', 'approved', 'superseded', 'cancelled']);
export type PrescriptionStatus = z.infer<typeof prescriptionStatusSchema>;

export const prescriptionSourceSchema = z.enum(['voice', 'typed', 'template', 'mixed']);
export type PrescriptionSource = z.infer<typeof prescriptionSourceSchema>;

export const printLanguageSchema = z.enum(['en', 'en_ur']);
export type PrintLanguage = z.infer<typeof printLanguageSchema>;

/**
 * How a medicine is taken through the day: morning / afternoon / night counts,
 * or `sos` for "as needed". Two shapes rather than one with nullable counts,
 * because "1-0-1 as needed" is not a thing a doctor writes.
 */
export const dosePatternSchema = z.union([
  z.object({
    m: z.number().int().min(0).max(12),
    a: z.number().int().min(0).max(12),
    n: z.number().int().min(0).max(12),
  }),
  z.object({ sos: z.literal(true) }),
]);
export type DosePattern = z.infer<typeof dosePatternSchema>;

export const medicineTimingSchema = z.enum(['before_meal', 'after_meal', 'with_meal', 'empty_stomach', 'any']);
export const medicineRouteSchema = z.enum(['oral', 'topical', 'injection', 'inhaled', 'drops', 'other']);
export const medicineFormSchema = z.enum([
  'tab',
  'cap',
  'syp',
  'inj',
  'drops',
  'cream',
  'ointment',
  'sachet',
  'spray',
  'other',
]);

/**
 * Why a line needs the doctor's eye before approval. Set by the voice pipeline,
 * never by a typed edit, and cleared when the doctor edits the line.
 */
export const medicineFlagSchema = z.enum([
  'dose_unclear',
  'drug_unknown',
  'strength_unclear',
  'duration_unclear',
  'route_unclear',
]);

/** A free-text line in one of the plain sections. */
export const textItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(2000),
  sourceSpanIds: z.array(z.string()).default([]),
});
export type TextItem = z.infer<typeof textItemSchema>;

export const diagnosisItemSchema = textItemSchema.extend({
  /** ICD-10 or similar, once there is a coder. Null until then. */
  code: z.string().trim().min(1).max(32).nullable().default(null),
});
export type DiagnosisItem = z.infer<typeof diagnosisItemSchema>;

export const medicineItemSchema = z.object({
  id: z.string().min(1),
  /** Points at `drugs`, or null while the drug is not in the collection yet. */
  drugId: objectIdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  strength: z.string().trim().max(60).default(''),
  form: medicineFormSchema.default('tab'),
  route: medicineRouteSchema.default('oral'),
  pattern: dosePatternSchema.default({ m: 1, a: 0, n: 0 }),
  timing: medicineTimingSchema.default('any'),
  durationDays: z.number().int().min(0).max(3650).default(0),
  instructionEn: z.string().trim().max(500).default(''),
  instructionUr: z.string().trim().max(500).default(''),
  flags: z.array(medicineFlagSchema).default([]),
  /** True when the doctor dictated a correction over this line. */
  correctedBySpeech: z.boolean().default(false),
  sourceSpanIds: z.array(z.string()).default([]),
});
export type MedicineItem = z.infer<typeof medicineItemSchema>;

export const followUpSchema = z.object({
  inDays: z.number().int().min(0).max(3650).nullable().default(null),
  date: dateStringSchema.nullable().default(null),
  note: z.string().trim().max(500).default(''),
});
export type FollowUp = z.infer<typeof followUpSchema>;

/** The sections that hold a list of items, in print order. */
export const LIST_SECTIONS = [
  'complaints',
  'history',
  'examination',
  'diagnosis',
  'medicines',
  'labs',
  'dietEat',
  'dietAvoid',
  'advice',
] as const;
export type ListSection = (typeof LIST_SECTIONS)[number];

/** Every section, including the one that is a single object. */
export const SECTIONS = [...LIST_SECTIONS, 'followUp'] as const;
export type Section = (typeof SECTIONS)[number];

export const sectionSchema = z.enum(SECTIONS);
export const listSectionSchema = z.enum(LIST_SECTIONS);

export const prescriptionSectionsSchema = z.object({
  complaints: z.array(textItemSchema).default([]),
  history: z.array(textItemSchema).default([]),
  examination: z.array(textItemSchema).default([]),
  diagnosis: z.array(diagnosisItemSchema).default([]),
  medicines: z.array(medicineItemSchema).default([]),
  labs: z.array(textItemSchema).default([]),
  dietEat: z.array(textItemSchema).default([]),
  dietAvoid: z.array(textItemSchema).default([]),
  advice: z.array(textItemSchema).default([]),
  followUp: followUpSchema.default({ inDays: null, date: null, note: '' }),
});
export type PrescriptionSections = z.infer<typeof prescriptionSectionsSchema>;

/**
 * Frozen onto the prescription when it is approved.
 *
 * The doctor's name, registration number and the clinic's address are all part
 * of a legal document, so every one of them is copied rather than referenced.
 * Editing the location or the practice afterwards must not change a page that
 * has already been printed and handed to a patient.
 */
export const letterheadSnapshotSchema = z.object({
  locationName: z.string().default(''),
  address: z.string().default(''),
  phone: z.string().default(''),
  timings: z.array(timingSchema).default([]),
  letterhead: bilingualSchema.default({ en: '', ur: '' }),
  doctorName: z.string().default(''),
  qualifications: z.array(z.string()).default([]),
  pmdcNo: z.string().default(''),
});
export type LetterheadSnapshot = z.infer<typeof letterheadSnapshotSchema>;

/** One doctor correction, kept so AI accuracy can be measured over time. */
export const editLogEntrySchema = z.object({
  at: z.coerce.date(),
  by: objectIdSchema,
  section: sectionSchema,
  itemId: z.string().nullable(),
  from: z.unknown().nullable(),
  to: z.unknown().nullable(),
});
export type EditLogEntry = z.infer<typeof editLogEntrySchema>;

/* ------------------------------------------------------------------ *
 * Operations
 *
 * The only way anything reaches `sections`. Voice produces these and so does a
 * typed edit, which is what keeps the two on one code path: the server
 * validates an op, applies it, and records it. Nothing writes a section
 * directly.
 * ------------------------------------------------------------------ */

/**
 * The item payload an op may carry, per section. `id` is absent on `add` (the
 * server mints it) and ignored on `update`, where the target comes from
 * `itemId`; everything else is optional on `update` so an op can nudge one
 * field. The unknown-key stripping of these schemas is the thing that stops an
 * LLM from inventing a field.
 */
export const opValueSchemas = {
  complaints: textItemSchema.omit({ id: true }),
  history: textItemSchema.omit({ id: true }),
  examination: textItemSchema.omit({ id: true }),
  labs: textItemSchema.omit({ id: true }),
  dietEat: textItemSchema.omit({ id: true }),
  dietAvoid: textItemSchema.omit({ id: true }),
  advice: textItemSchema.omit({ id: true }),
  diagnosis: diagnosisItemSchema.omit({ id: true }),
  medicines: medicineItemSchema.omit({ id: true }),
  followUp: followUpSchema,
} as const;

export const opKindSchema = z.enum(['add', 'update', 'remove']);
export type OpKind = z.infer<typeof opKindSchema>;

/**
 * Shape-only validation. Which fields a given section accepts is checked
 * against `opValueSchemas` by the server, because that check depends on
 * `section` and on whether the op adds or updates.
 */
export const opSchema = z.object({
  op: opKindSchema,
  section: sectionSchema,
  itemId: z.string().min(1).nullable().optional(),
  value: z.unknown().optional(),
  spanIds: z.array(z.string()).default([]),
});
export type Op = z.infer<typeof opSchema>;

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

export const createPrescriptionBodySchema = z.object({
  patientId: objectIdSchema,
  visitId: objectIdSchema.nullable().optional(),
  source: prescriptionSourceSchema.default('typed'),
  printLanguage: printLanguageSchema.default('en_ur'),
});
export type CreatePrescriptionBody = z.infer<typeof createPrescriptionBodySchema>;

export const patchPrescriptionBodySchema = z
  .object({
    ops: z.array(opSchema).max(200).default([]),
    printLanguage: printLanguageSchema.optional(),
  })
  .refine((body) => body.ops.length > 0 || body.printLanguage !== undefined, 'nothing to change');
export type PatchPrescriptionBody = z.infer<typeof patchPrescriptionBodySchema>;

export const revisePrescriptionBodySchema = z.object({
  reason: z.string().trim().max(500).default(''),
});
export type RevisePrescriptionBody = z.infer<typeof revisePrescriptionBodySchema>;

export const listPrescriptionsQuerySchema = z.object({
  patientId: objectIdSchema.optional(),
  status: prescriptionStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListPrescriptionsQuery = z.infer<typeof listPrescriptionsQuerySchema>;
