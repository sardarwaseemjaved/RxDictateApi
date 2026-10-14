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
 * `key` is the scope: `visitToken:<locationId>:<YYYY-MM-DD>`.
 */
export interface ICounter {
  practiceId: Types.ObjectId;
  key: string;
  seq: number;
  createdAt: Date;
  updatedAt: Date;
}

export type CounterDoc = HydratedDocument<ICounter>;

const counterSchema = new Schema<ICounter>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    key: { type: String, required: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true },
);

counterSchema.plugin(toJSON);

counterSchema.index({ practiceId: 1, key: 1 }, { unique: true });

export const Counter = mongoose.model<ICounter>('Counter', counterSchema, 'counters');
export default Counter;
