import { z } from 'zod';
import { objectIdSchema, phoneSchema } from './common';
import { roleSchema } from './roles';

export const sendOtpBodySchema = z.object({
  phone: phoneSchema,
});
export type SendOtpBody = z.infer<typeof sendOtpBodySchema>;

export const verifyOtpBodySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{6}$/, 'must be the 6 digit code'),
  /** Only used the very first time a phone signs in, to name the new practice. */
  name: z.string().trim().min(1).max(120).optional(),
});
export type VerifyOtpBody = z.infer<typeof verifyOtpBodySchema>;

export const sendOtpResultSchema = z.object({
  sent: z.literal(true),
  /** Dev and test only: the code that was issued, so a sign-in needs no SMS. */
  devCode: z.string().optional(),
});
export type SendOtpResult = z.infer<typeof sendOtpResultSchema>;

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshBody = z.infer<typeof refreshBodySchema>;

export const logoutBodySchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutBody = z.infer<typeof logoutBodySchema>;

export const tokenPairSchema = z.object({
  access: z.object({ token: z.string(), expires: z.coerce.date() }),
  refresh: z.object({ token: z.string(), expires: z.coerce.date() }),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

/** What a membership looks like to the app, with its locations resolved. */
export const membershipViewSchema = z.object({
  id: objectIdSchema,
  practiceId: objectIdSchema,
  practiceName: z.string(),
  role: roleSchema,
  locationIds: z.array(objectIdSchema),
  locations: z.array(
    z.object({
      id: objectIdSchema,
      name: z.string(),
      isDefault: z.boolean(),
      status: z.enum(['active', 'archived']),
    }),
  ),
});
export type MembershipView = z.infer<typeof membershipViewSchema>;

export const sessionSchema = z.object({
  user: z.object({
    id: objectIdSchema,
    phone: phoneSchema,
    name: z.string(),
    lastLoginAt: z.coerce.date().nullable(),
  }),
  memberships: z.array(membershipViewSchema),
  tokens: tokenPairSchema,
  /** Dev and test only: the code that was issued, so a sign-in needs no SMS. */
  devCode: z.string().optional(),
});
export type Session = z.infer<typeof sessionSchema>;
