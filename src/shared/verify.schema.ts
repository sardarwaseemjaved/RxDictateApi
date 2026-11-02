import { z } from 'zod';
import { sexSchema } from './common';
import { medicineItemSchema } from './prescription.schema';

/**
 * Checking a printed prescription against what the doctor approved.
 *
 * The printout carries a QR code holding a link, `{VERIFY_BASE_URL}/{code}`,
 * and never any patient data. The code is 16 random bytes, made at approval,
 * so it cannot be guessed from the Rx number or the id. The page the link
 * opens is public and permanent - paper is kept for months - so the answer
 * carries only what a pharmacist needs to compare against the paper.
 */

/** Under /api/v1, public: the QR image a printout shows. */
export const verifyQrPath = (code: string) => `/verify/${code}/qr.svg`;

/** `replaced` once a revision has been approved in its place. */
export const verifyStatusSchema = z.enum(['valid', 'replaced']);
export type VerifyStatus = z.infer<typeof verifyStatusSchema>;

export const verifyViewSchema = z.object({
  status: verifyStatusSchema,
  /** The Rx ID as printed. */
  number: z.string(),
  approvedAt: z.coerce.date(),
  /** From the prescription's letterheadSnapshot, as printed. */
  doctor: z.object({
    name: z.string(),
    qualifications: z.array(z.string()),
    speciality: z.string(),
    pmdcNo: z.string(),
  }),
  clinic: z.object({ name: z.string(), address: z.string() }),
  /** Enough to match the paper to the person, not to identify them. */
  patient: z.object({
    initials: z.string(),
    age: z.number().int().nullable(),
    sex: sexSchema,
  }),
  /** Empty when `replaced`: the old list is no longer valid. */
  medicines: z.array(
    medicineItemSchema.pick({
      name: true,
      strength: true,
      form: true,
      route: true,
      pattern: true,
      timing: true,
      durationDays: true,
      instructionEn: true,
      instructionUr: true,
    }),
  ),
  /** When `replaced`: the approved version that took its place. */
  replacedBy: z.object({ number: z.string(), approvedAt: z.coerce.date() }).nullable(),
});
export type VerifyView = z.infer<typeof verifyViewSchema>;
