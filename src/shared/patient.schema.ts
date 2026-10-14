import { z } from 'zod';
import { dateStringSchema, objectIdSchema, phoneSchema, sexSchema } from './common';

/**
 * At most twenty, each short: this is a list a PA types at the desk, not a
 * medical history. An empty list means nothing is recorded, which is not the
 * same as "asked, none" - that is what noKnownAllergies is for.
 */
export const allergiesSchema = z.array(z.string().trim().min(1).max(60)).max(20);

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
});
export type PatientView = z.infer<typeof patientViewSchema>;

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
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change')
  .refine(
    (body) => !(body.noKnownAllergies === true && (body.allergies?.length ?? 0) > 0),
    'noKnownAllergies cannot be true when allergies are listed',
  );
export type UpdatePatientBody = z.infer<typeof updatePatientBodySchema>;

/**
 * Patient search is practice-wide on purpose: a patient who was first seen at
 * one location must be findable at another without being typed in twice.
 *
 * `q` matches a name, an MR number (with or without the `MR-` prefix, in any
 * case) or the start of a phone number. A bare number is tried as both an MR
 * number and a phone prefix, because at the desk it could be either.
 */
export const searchPatientsQuerySchema = z.object({
  q: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type SearchPatientsQuery = z.infer<typeof searchPatientsQuerySchema>;
