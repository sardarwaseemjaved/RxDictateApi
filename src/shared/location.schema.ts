import { z } from 'zod';
import { bilingualSchema, objectIdSchema, timingSchema } from './common';

export const locationStatusSchema = z.enum(['active', 'archived']);
export type LocationStatus = z.infer<typeof locationStatusSchema>;

/**
 * Where a location is, as something that can be matched on: an event in
 * Lahore reaches the clinics in Lahore. The values are keys, never shown:
 * PROVINCE_LABELS is what a screen says.
 */
export const PROVINCES = [
  'punjab',
  'sindh',
  'khyberPakhtunkhwa',
  'balochistan',
  'islamabadCapitalTerritory',
  'gilgitBaltistan',
  'azadKashmir',
] as const;

export const provinceSchema = z.enum(PROVINCES);
export type Province = z.infer<typeof provinceSchema>;

export const PROVINCE_LABELS: Record<Province, string> = {
  punjab: 'Punjab',
  sindh: 'Sindh',
  khyberPakhtunkhwa: 'Khyber Pakhtunkhwa',
  balochistan: 'Balochistan',
  islamabadCapitalTerritory: 'Islamabad Capital Territory',
  gilgitBaltistan: 'Gilgit-Baltistan',
  azadKashmir: 'Azad Kashmir',
};

/** "dera ismail KHAN" -> "Dera Ismail Khan", "d.i. khan" -> "D.I. Khan". */
export const toTitleCase = (text: string): string =>
  text
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s.(-])([a-z])/g, (_match, before: string, letter: string) => `${before}${letter.toUpperCase()}`);

/**
 * Typed, not picked: there are too many towns for a list. Stored in title case
 * so "lahore" and "LAHORE" are the same city when something is matched on it.
 * Blank is no city.
 */
export const citySchema = z
  .string()
  .max(80)
  .transform((city) => (city.trim() === '' ? null : toTitleCase(city)));

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
  province: provinceSchema.nullable(),
  city: z.string().nullable(),
});
export type LocationView = z.infer<typeof locationViewSchema>;

/** Each field once, with no defaults, so a patch leaves alone what it does not name. */
const locationFields = {
  name: z.string().trim().min(1).max(160),
  address: z.string().trim().max(500),
  phone: z.string().trim().max(40),
  timings: z.array(timingSchema).max(7),
  letterhead: bilingualSchema,
  isDefault: z.boolean(),
  province: provinceSchema.nullable(),
  city: citySchema.nullable(),
};

export const createLocationBodySchema = z.object({
  name: locationFields.name,
  address: locationFields.address.default(''),
  phone: locationFields.phone.default(''),
  timings: locationFields.timings.default([]),
  letterhead: locationFields.letterhead.default({ en: '', ur: '' }),
  isDefault: locationFields.isDefault.default(false),
  province: locationFields.province.default(null),
  city: locationFields.city.default(null),
});
export type CreateLocationBody = z.infer<typeof createLocationBodySchema>;

export const updateLocationBodySchema = z
  .object(locationFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateLocationBody = z.infer<typeof updateLocationBodySchema>;

export const listLocationsQuerySchema = z.object({
  status: locationStatusSchema.optional(),
});
export type ListLocationsQuery = z.infer<typeof listLocationsQuerySchema>;
