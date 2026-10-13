import { z } from 'zod';
import { bilingualSchema, objectIdSchema, timingSchema } from './common';

export const locationStatusSchema = z.enum(['active', 'archived']);
export type LocationStatus = z.infer<typeof locationStatusSchema>;

export const locationViewSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  address: z.string(),
  phone: z.string(),
  timings: z.array(timingSchema),
  /** The block printed at the top of an A4 prescription, in both languages. */
  letterhead: bilingualSchema,
  isDefault: z.boolean(),
  status: locationStatusSchema,
});
export type LocationView = z.infer<typeof locationViewSchema>;

export const createLocationBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().max(500).default(''),
  phone: z.string().trim().max(40).default(''),
  timings: z.array(timingSchema).max(7).default([]),
  letterhead: bilingualSchema.default({ en: '', ur: '' }),
  isDefault: z.boolean().default(false),
});
export type CreateLocationBody = z.infer<typeof createLocationBodySchema>;

export const updateLocationBodySchema = createLocationBodySchema
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateLocationBody = z.infer<typeof updateLocationBodySchema>;

export const listLocationsQuerySchema = z.object({
  status: locationStatusSchema.optional(),
});
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;
