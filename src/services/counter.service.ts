import type { Types } from 'mongoose';
import { Counter, Practice } from '../models';
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

/**
 * The next value of a named sequence, by one atomic $inc.
 *
 * The upsert is what makes the first call of the day safe; two of them racing
 * can both miss the document and one loses on the unique index, which is why
 * that case retries once rather than failing a patient's registration.
 */
const nextInSequence = async (practiceId: Types.ObjectId, key: string): Promise<number> => {
  try {
    const counter = await Counter.findOneAndUpdate({ practiceId, key }, { $inc: { seq: 1 } }, { new: true, upsert: true });
    return counter.seq;
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) {
      throw error;
    }
    // The row exists now, put there by whoever won the race.
    const counter = await Counter.findOneAndUpdate({ practiceId, key }, { $inc: { seq: 1 } }, { new: true });
    if (!counter) {
      throw new AppError('INTERNAL', 'could not allocate a number', undefined, false);
    }
    return counter.seq;
  }
};

/**
 * The next waiting-room token: per location, per day, starting at 1.
 *
 * Never reused. A visit that is removed takes its number with it, because the
 * patient holding that slip has already heard it called and handing it to
 * somebody else is how two people stand up at once.
 */
export const nextVisitToken = async (
  practiceId: Types.ObjectId,
  locationId: Types.ObjectId,
  date: string,
): Promise<number> => nextInSequence(practiceId, `visitToken:${String(locationId)}:${date}`);

/**
 * The next MR number for a practice, e.g. MR-10001.
 *
 * On the practice document beside rxCounter rather than in counters, because
 * it is one sequence per practice for the life of the practice, and because
 * that is where the only other human-readable number already lives.
 */
export const nextMrNo = async (practiceId: Types.ObjectId): Promise<string> => {
  const practice = await Practice.findOneAndUpdate(
    { _id: practiceId, deletedAt: null },
    { $inc: { mrCounter: 1 } },
    { new: true },
  );
  if (!practice) {
    throw AppError.notFound('Clinic');
  }
  return `MR-${practice.mrCounter}`;
};

export default { nextPrescriptionNumber, nextVisitToken, nextMrNo };
