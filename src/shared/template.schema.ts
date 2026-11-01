import { z } from 'zod';
import { objectIdSchema } from './common';
import { prescriptionSectionsSchema } from './prescription.schema';

/**
 * A saved set of sections a doctor starts a prescription from: "Hypertension",
 * "Viral fever".
 *
 * `sections` is the same shape a prescription carries, so applying a template
 * is a copy rather than a translation. Item ids are required as they are on a
 * prescription; any unique string will do, because the server mints fresh ids
 * when a template is applied.
 *
 * Some things never survive into a template, whichever way it is made:
 *
 * - the follow-up's `date`, which is about one patient. The interval
 *   (`inDays`) is the habit worth keeping, and it is kept;
 * - a medicine's `flags`, `correctedBySpeech` and every `sourceSpanIds`, which
 *   describe one dictation and not the regimen.
 *
 * A template belongs to the doctor who made it. Two doctors at one clinic
 * each keep their own.
 */
export const templateNameSchema = z.string().trim().min(1).max(80);

export const templateViewSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  sections: prescriptionSectionsSchema,
  /** How many prescriptions have been started from it, or had it added. */
  useCount: z.number().int().min(0),
  /** Null until it is first used. */
  lastUsedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  /** Moves when the template is edited, not when it is used. */
  updatedAt: z.coerce.date(),
});
export type TemplateView = z.infer<typeof templateViewSchema>;

/**
 * Either the sections themselves, or `fromPrescriptionId` for "Save as
 * template", which copies an approved prescription. Copying leaves out the
 * complaints, history and examination: those describe the patient the
 * prescription was written for, and would otherwise turn up on the next
 * patient's page.
 */
export const createTemplateBodySchema = z
  .object({
    name: templateNameSchema,
    sections: prescriptionSectionsSchema.optional(),
    fromPrescriptionId: objectIdSchema.optional(),
  })
  .refine(
    (body) => (body.sections === undefined) !== (body.fromPrescriptionId === undefined),
    'give either sections or fromPrescriptionId',
  );
export type CreateTemplateBody = z.infer<typeof createTemplateBodySchema>;

/** `sections`, when sent, replaces the template's sections whole. */
export const updateTemplateBodySchema = z
  .object({
    name: templateNameSchema.optional(),
    sections: prescriptionSectionsSchema.optional(),
  })
  .refine((body) => body.name !== undefined || body.sections !== undefined, 'nothing to change');
export type UpdateTemplateBody = z.infer<typeof updateTemplateBodySchema>;

/** Most used first, then by name. */
export const listTemplatesQuerySchema = z.object({
  /** Any part of the name, in any case. */
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListTemplatesQuery = z.infer<typeof listTemplatesQuerySchema>;
