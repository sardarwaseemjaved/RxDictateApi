import { z } from 'zod';
import { objectIdSchema, phoneSchema } from './common';
import { membershipViewSchema } from './auth.schema';

export const updateMeBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateMeBody = z.infer<typeof updateMeBodySchema>;

export const meViewSchema = z.object({
  id: objectIdSchema,
  phone: phoneSchema,
  name: z.string(),
  lastLoginAt: z.coerce.date().nullable(),
  memberships: z.array(membershipViewSchema),
});
export type MeView = z.infer<typeof meViewSchema>;
