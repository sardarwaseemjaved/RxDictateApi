import { z } from 'zod';
import { objectIdSchema, phoneSchema } from './common';
import { membershipStatusSchema, roleSchema } from './roles';

export const memberViewSchema = z.object({
  id: objectIdSchema,
  userId: objectIdSchema,
  name: z.string(),
  phone: phoneSchema,
  role: roleSchema,
  locationIds: z.array(objectIdSchema),
  status: membershipStatusSchema,
});
export type MemberView = z.infer<typeof memberViewSchema>;

/**
 * A member is added by phone number, never by an invite code: the doctor types
 * the number, the server finds or creates that user, and she is in.
 */
export const addMemberBodySchema = z.object({
  phone: phoneSchema,
  name: z.string().trim().min(1).max(120).optional(),
  role: roleSchema.exclude(['patient']).default('pa'),
  locationIds: z.array(objectIdSchema).min(1),
});
export type AddMemberBody = z.infer<typeof addMemberBodySchema>;

export const updateMemberBodySchema = z
  .object({
    role: roleSchema.exclude(['patient']).optional(),
    locationIds: z.array(objectIdSchema).min(1).optional(),
    name: z.string().trim().min(1).max(120).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateMemberBody = z.infer<typeof updateMemberBodySchema>;

export const listMembersQuerySchema = z.object({
  status: membershipStatusSchema.optional(),
});
export type ListMembersQuery = z.infer<typeof listMembersQuerySchema>;
