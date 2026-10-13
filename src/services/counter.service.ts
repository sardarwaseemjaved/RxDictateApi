import type { Types } from 'mongoose';
import { Practice } from '../models';
import { AppError } from '../core/errors';
import { karachiDay } from '../utils/time';

/**
 * The next prescription number for a practice, e.g. RX-2026-000418.
 *
 * One atomic findOneAndUpdate with $inc, and the incremented value is read back
 * from the same operation. A read-then-write here is the classic way to put the
 * same number on two prescriptions, and a prescription number is what a patient
 * and a pharmacist quote back about a legal document.
 *
 * The counter does not reset each year. The year in the string is the year of
 * approval; resetting it would mean a second counter per year and a window
 * where two approvals could collide.
 */
export const nextPrescriptionNumber = async (practiceId: Types.ObjectId, when: Date = new Date()): Promise<string> => {
  const practice = await Practice.findOneAndUpdate(
    { _id: practiceId, deletedAt: null },
    { $inc: { rxCounter: 1 } },
    { new: true },
  );
  if (!practice) {
    throw AppError.notFound('Clinic');
  }

  const year = karachiDay(when).slice(0, 4);
  return `RX-${year}-${String(practice.rxCounter).padStart(6, '0')}`;
};

export default { nextPrescriptionNumber };
