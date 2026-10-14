import { z } from 'zod';
import { objectIdSchema } from './common';

/**
 * Which parts of the product this practice has switched on. Read by the app to
 * decide what to show, and by the server to refuse work it should not do.
 */
export const practiceFeaturesSchema = z.object({
  voice: z.boolean().default(true),
  templates: z.boolean().default(false),
});
export type PracticeFeatures = z.infer<typeof practiceFeaturesSchema>;

export const practiceSettingsSchema = z.object({
  /** Days after approval that dictation audio is kept before it is deleted. */
  audioRetentionDays: z.number().int().min(1).max(365).default(30),
});
export type PracticeSettings = z.infer<typeof practiceSettingsSchema>;

export const practiceViewSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  ownerId: objectIdSchema,
  pmdcNo: z.string(),
  qualifications: z.array(z.string()),
  /** "Consultant Physician". Printed under the doctor's name on a prescription. */
  speciality: z.string(),
  features: practiceFeaturesSchema,
  settings: practiceSettingsSchema,
});
export type PracticeView = z.infer<typeof practiceViewSchema>;

export const updatePracticeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    pmdcNo: z.string().trim().max(60).optional(),
    qualifications: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
    speciality: z.string().trim().max(120).optional(),
    features: practiceFeaturesSchema.partial().optional(),
    settings: practiceSettingsSchema.partial().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdatePracticeBody = z.infer<typeof updatePracticeBodySchema>;
