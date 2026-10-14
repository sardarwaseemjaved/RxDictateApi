import { z } from 'zod';
import { objectIdSchema } from './common';

/** `110/70`. Stored as written, because a blood pressure is a pair, not a number. */
export const bloodPressureSchema = z.string().regex(/^\d{2,3}\/\d{2,3}$/, 'must look like 110/70');

/**
 * What the PA measures before the doctor sees the patient.
 *
 * Every reading is optional - a clinic that owns no pulse oximeter should not
 * be blocked - but a record with nothing measured in it is not a record, so at
 * least one reading is required. Complaints alone do not count: those belong on
 * the visit.
 */
export const vitalsSchema = z
  .object({
    bp: bloodPressureSchema.optional(),
    /** Beats per minute. */
    pulse: z.number().int().min(20).max(300).optional(),
    /** Degrees Fahrenheit, which is what clinics here use. */
    tempF: z.number().min(85).max(115).optional(),
    weightKg: z.number().min(0.5).max(400).optional(),
    /** Oxygen saturation, percent. */
    spo2: z.number().int().min(50).max(100).optional(),
    /** Random blood sugar, mg/dL. Null is "tested, no figure"; absent is "not tested". */
    bloodSugarRandom: z.number().min(10).max(1000).nullable().optional(),
    complaints: z.string().trim().max(1000).default(''),
  })
  .refine(
    (vitals) =>
      vitals.bp !== undefined ||
      vitals.pulse !== undefined ||
      vitals.tempF !== undefined ||
      vitals.weightKg !== undefined ||
      vitals.spo2 !== undefined ||
      (vitals.bloodSugarRandom !== undefined && vitals.bloodSugarRandom !== null),
    'at least one reading is required',
  );
export type Vitals = z.infer<typeof vitalsSchema>;

export const vitalsViewSchema = z.object({
  id: objectIdSchema,
  visitId: objectIdSchema,
  bp: bloodPressureSchema.nullable(),
  pulse: z.number().int().nullable(),
  tempF: z.number().nullable(),
  weightKg: z.number().nullable(),
  spo2: z.number().int().nullable(),
  bloodSugarRandom: z.number().nullable(),
  complaints: z.string(),
  recordedBy: objectIdSchema,
  recordedAt: z.coerce.date(),
});
export type VitalsView = z.infer<typeof vitalsViewSchema>;

/* ------------------------------------------------------------------ *
 * Normal ranges
 * ------------------------------------------------------------------ */

export interface VitalRange {
  min?: number;
  max?: number;
  unit: string;
}

/**
 * Adult resting ranges. Deliberately here and not on the server alone: the app
 * highlights a reading the moment it is typed, the server flags the same
 * reading for the doctor, and the two disagreeing in front of a patient would
 * be worse than either being slightly wrong.
 *
 * These are screening thresholds for a general clinic, not a diagnosis, and
 * they are wrong for children. A paediatric practice will need ranges by age,
 * which is a change to this table and to nothing else.
 */
export const VITAL_RANGES = {
  systolic: { min: 90, max: 140, unit: 'mmHg' },
  diastolic: { min: 60, max: 90, unit: 'mmHg' },
  pulse: { min: 60, max: 100, unit: '/min' },
  tempF: { min: 97, max: 99.5, unit: '°F' },
  spo2: { min: 95, unit: '%' },
  bloodSugarRandom: { min: 70, max: 140, unit: 'mg/dL' },
} as const satisfies Record<string, VitalRange>;

export type VitalField = keyof typeof VITAL_RANGES;

export interface VitalFlag {
  field: VitalField;
  level: 'low' | 'high';
  value: number;
  range: VitalRange;
}

/** Split `110/70` into its two numbers. Null when it is not a blood pressure. */
export const parseBp = (bp: string | null | undefined): { systolic: number; diastolic: number } | null => {
  if (!bp) return null;
  const match = /^(\d{2,3})\/(\d{2,3})$/.exec(bp);
  if (!match) return null;
  return { systolic: Number(match[1]), diastolic: Number(match[2]) };
};

const check = (field: VitalField, value: number | null | undefined, flags: VitalFlag[]): void => {
  if (value === null || value === undefined) return;
  const range: VitalRange = VITAL_RANGES[field];
  if (range.min !== undefined && value < range.min) {
    flags.push({ field, level: 'low', value, range });
  } else if (range.max !== undefined && value > range.max) {
    flags.push({ field, level: 'high', value, range });
  }
};

/**
 * Which readings are outside the normal range. Pure, so both sides can call it
 * and a test can check it without a database.
 */
export const vitalFlags = (vitals: Partial<VitalsView> | Vitals): VitalFlag[] => {
  const flags: VitalFlag[] = [];
  const bp = parseBp(vitals.bp ?? null);
  if (bp) {
    check('systolic', bp.systolic, flags);
    check('diastolic', bp.diastolic, flags);
  }
  check('pulse', vitals.pulse, flags);
  check('tempF', vitals.tempF, flags);
  check('spo2', vitals.spo2, flags);
  check('bloodSugarRandom', vitals.bloodSugarRandom, flags);
  return flags;
};

export const recordVitalsBodySchema = vitalsSchema;
export type RecordVitalsBody = z.infer<typeof recordVitalsBodySchema>;
