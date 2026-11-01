import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';

/**
 * Sequences that have to be dense, gapless-ish and never reused: today's
 * waiting-room token at one location, and anything else that gets counted out
 * loud.
 *
 * A row per scope, moved only by an atomic $inc, for the same reason
 * practices.rxCounter exists: computing the next number with max() + 1 reuses
 * a number as soon as a row is removed, and two people adding a patient in the
 * same second both read the same max.
 *
 * `key` is the scope: `visitToken:<locationId>:<YYYY-MM-DD>`, or
 * `visitQueue:<locationId>:<YYYY-MM-DD>` for the lease below.
 */
export interface ICounter {
  practiceId: Types.ObjectId;
  key: string;
  seq: number;
  /**
   * Only on `visitQueue` rows: a short lease held while one move rewrites a
   * day's positions, so two people rearranging the same list take turns rather
   * than each working from what the other is about to change. `seq` counts the
   * leases taken, and is how the holder knows the lease is still its own.
   */
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CounterDoc = HydratedDocument<ICounter>;

const counterSchema = new Schema<ICounter>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    key: { type: String, required: true },
    seq: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true },
);

counterSchema.plugin(toJSON);

counterSchema.index({ practiceId: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model<ICounter>('Counter', counterSchema, 'counters');
export default Counter;
