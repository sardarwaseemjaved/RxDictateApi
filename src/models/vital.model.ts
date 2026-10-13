import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';

/** What the PA measures before the doctor sees the patient. One row per visit. */
export interface IVital {
  practiceId: Types.ObjectId;
  visitId: Types.ObjectId;
  /** As written, e.g. "120/80": a blood pressure is a pair, not a number. */
  bp: string;
  pulse: number | null;
  temp: number | null;
  weight: number | null;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type VitalDoc = HydratedDocument<IVital>;

const vitalSchema = new Schema<IVital>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit', required: true },
    bp: { type: String, default: '' },
    pulse: { type: Number, default: null },
    temp: { type: Number, default: null },
    weight: { type: Number, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

vitalSchema.plugin(toJSON);

vitalSchema.index({ visitId: 1 });

export const Vital = mongoose.model<IVital>('Vital', vitalSchema, 'vitals');
export default Vital;
