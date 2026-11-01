import { z } from 'zod';
import { dateStringSchema, objectIdSchema, phoneSchema, sexSchema } from './common';

/**
 * At most twenty, each short: this is a list a PA types at the desk, not a
 * medical history. An empty list means nothing is recorded, which is not the
 * same as "asked, none" - that is what noKnownAllergies is for.
 */
export const allergiesSchema = z.array(z.string().trim().min(1).max(60)).max(20);

/**
 * Known conditions - "Diabetes", "Hypertension". The same shape as allergies
 * and for the same reason: a short list somebody types at a desk, not a
 * problem list with codes and dates.
 */
export const conditionsSchema = z.array(z.string().trim().min(1).max(60)).max(20);

/** `MR-10001`. Human readable, unique within a practice, never reused. */
export const mrNoSchema = z.string().regex(/^MR-\d+$/);

export const patientViewSchema = z.object({
  id: objectIdSchema,
  /** Assigned by the server at creation and never changed. */
  mrNo: mrNoSchema,
  name: z.string(),
  phone: z.string(),
  dob: dateStringSchema.nullable(),
  /** Taken from `dob` when there is one, otherwise the age that was typed in. */
  age: z.number().int().nullable(),
  sex: sexSchema,
  allergies: allergiesSchema,
  /**
   * The difference between "we asked and there are none" and "nobody has
   * asked". A blank allergies list cannot tell you which, and on a
   * prescription that distinction matters.
   */
  noKnownAllergies: z.boolean(),
  conditions: conditionsSchema,
  /**
   * The day this patient was last on a list, which the patients screen shows
   * as "Today", "Yesterday" or a date. Derived from their visits and
   * maintained by the server; read-only.
   */
  lastVisitDate: dateStringSchema.nullable(),
});
export type PatientView = z.infer<typeof patientViewSchema>;

/**
 * Enough to put a name on a row: a list of prescriptions shows who each one is
 * for without a patient request per row. A subset of PatientView, so the same
 * patient reads the same everywhere.
 */
export const patientSummarySchema = patientViewSchema.pick({ id: true, name: true, age: true, sex: true, mrNo: true });
export type PatientSummary = z.infer<typeof patientSummarySchema>;

/**
 * Age is accepted as an alternative to a date of birth because most patients
 * do not know theirs. When a dob is given it wins and age is derived from it.
 */
export const createPatientBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    phone: phoneSchema.optional(),
    dob: dateStringSchema.optional(),
    age: z.number().int().min(0).max(130).optional(),
    sex: sexSchema,
    allergies: allergiesSchema.default([]),
    noKnownAllergies: z.boolean().default(false),
    conditions: conditionsSchema.default([]),
  })
  .refine((body) => body.dob !== undefined || body.age !== undefined, 'either dob or age is required')
  .refine(
    (body) => !(body.noKnownAllergies && body.allergies.length > 0),
    'noKnownAllergies cannot be true when allergies are listed',
  );
export type CreatePatientBody = z.infer<typeof createPatientBodySchema>;

export const updatePatientBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    phone: phoneSchema.optional(),
    dob: dateStringSchema.nullable().optional(),
    age: z.number().int().min(0).max(130).nullable().optional(),
    sex: sexSchema.optional(),
    allergies: allergiesSchema.optional(),
    noKnownAllergies: z.boolean().optional(),
    conditions: conditionsSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change')
  .refine(
    (body) => !(body.noKnownAllergies === true && (body.allergies?.length ?? 0) > 0),
    'noKnownAllergies cannot be true when allergies are listed',
  );
export type UpdatePatientBody = z.infer<typeof updatePatientBodySchema>;

/**
 * The doctor's patient search is practice-wide on purpose: a patient who was
 * first seen at one location must be findable at another without being typed
 * in twice. An assistant's covers the patients linked to the locations they
 * work at - registered, seen or booked there - plus anyone whose whole phone
 * number they type, so a patient arriving at a second location is added to the
 * list there rather than registered again.
 *
 * `q` matches a name, an MR number (with or without the `MR-` prefix, in any
 * case) or the start of a phone number. A bare number is tried as both an MR
 * number and a phone prefix, because at the desk it could be either.
 */
/** A query-string boolean, where everything arrives as text. */
const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const patientSortSchema = z.enum(['name', 'lastVisit']);
export type PatientSort = z.infer<typeof patientSortSchema>;

export const searchPatientsQuerySchema = z.object({
  q: z.string().trim().max(160).optional(),
  /** `name` stays the default; the patients screen asks for `lastVisit`. */
  sort: patientSortSchema.default('name'),
  /**
   * An approved follow-up whose date has passed, with no visit since. The
   * patient the doctor meant to see again and has not.
   */
  followUpDue: flag,
  /** A report nobody has marked reviewed yet. */
  newReports: flag,
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type SearchPatientsQuery = z.infer<typeof searchPatientsQuerySchema>;

/**
 * The chip counts above the patients list.
 *
 * Counted on every list rather than asked for separately, because a chip that
 * says "Follow-up due" with no number is a chip nobody taps. `all` ignores the
 * filters so the "All" chip can show the practice's total while a filter is on.
 */
export const patientCountsSchema = z.object({
  all: z.number().int().min(0),
  followUpDue: z.number().int().min(0),
  newReports: z.number().int().min(0),
});
export type PatientCounts = z.infer<typeof patientCountsSchema>;

export const patientListMetaSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  counts: patientCountsSchema,
});
export type PatientListMeta = z.infer<typeof patientListMetaSchema>;
