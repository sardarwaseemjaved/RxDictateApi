import { z } from 'zod';

/** A 24-character hex Mongo ObjectId, as the app sees it. */
export const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'must be a valid id');

/**
 * E.164, which is the only phone shape stored anywhere: a leading +, a country
 * code, then digits. Pakistani mobiles look like +923001234567.
 */
export const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'must be a phone number in E.164 format, e.g. +923001234567');

/** A calendar date with no timezone, `YYYY-MM-DD`. Used for DOB and visit days. */
export const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in the format YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  }, 'must be a real calendar date');

/** Zero padded 24 hour time, `HH:mm`, which makes times comparable as plain strings. */
export const timeStringSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time in the format HH:mm');

/** Anything that prints in Urdu carries both renderings. */
export const bilingualSchema = z.object({
  en: z.string().trim().default(''),
  ur: z.string().trim().default(''),
});
export type Bilingual = z.infer<typeof bilingualSchema>;

export const idParamSchema = z.object({ id: objectIdSchema });

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const sexSchema = z.enum(['male', 'female', 'other']);
export type Sex = z.infer<typeof sexSchema>;

/** The clinic's opening hours for one weekday, as printed on the letterhead. */
export const timingSchema = z.object({
  day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  from: timeStringSchema,
  to: timeStringSchema,
  closed: z.boolean().default(false),
});
export type Timing = z.infer<typeof timingSchema>;
