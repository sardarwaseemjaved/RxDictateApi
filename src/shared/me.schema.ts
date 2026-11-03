import { z } from 'zod';
import { objectIdSchema, phoneSchema } from './common';
import { membershipViewSchema } from './auth.schema';
import { specialtiesSchema, specialtySchema } from './specialties';

export const updateMeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** The whole list, replacing the one before. Empty clears it. */
    specialties: specialtiesSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;

export const meViewSchema = z.object({
  id: objectIdSchema,
  phone: phoneSchema,
  name: z.string(),
  lastLoginAt: z.coerce.date().nullable(),
  /** What this person practises. Theirs, not a clinic's, so it is the same in every clinic they belong to. */
  specialties: z.array(specialtySchema),
  memberships: z.array(membershipViewSchema),
});
export type MeView = z.infer<typeof meViewSchema>;
