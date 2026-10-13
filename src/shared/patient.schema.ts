import { z } from 'zod';
import { dateStringSchema, objectIdSchema, phoneSchema, sexSchema } from './common';

export const patientViewSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  phone: z.string(),
  dob: dateStringSchema.nullable(),
  /** Taken from `dob` when there is one, otherwise the age that was typed in. */
  age: z.number().int().nullable(),
  sex: sexSchema,
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
  })
  .refine((body) => body.dob !== undefined || body.age !== undefined, 'either dob or age is required');
export type CreatePatientBody = z.infer<typeof createPatientBodySchema>;

export const updatePatientBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    phone: phoneSchema.optional(),
    dob: dateStringSchema.nullable().optional(),
    age: z.number().int().min(0).max(130).nullable().optional(),
    sex: sexSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdatePatientBody = z.infer<typeof updatePatientBodySchema>;

/**
 * Patient search is practice-wide on purpose: a patient who was first seen at
 * one location must be findable at another without being typed in twice.
 */
export const searchPatientsQuerySchema = z.object({
  q: z.string().trim().max(160).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type SearchPatientsQuery = z.infer<typeof searchPatientsQuerySchema>;
