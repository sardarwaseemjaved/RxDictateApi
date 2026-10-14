import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';

/**
 * What the PA measures before the doctor sees the patient. One record per
 * visit, replaced rather than appended to: a correction to a reading taken two
 * minutes ago is a correction, not a second set of observations.
 *
 * Units are in the field names on purpose. A number called `temp` is a bug
 * waiting for the first clinic that thinks in Celsius.
 */
export interface IVital {
  practiceId: Types.ObjectId;
  visitId: Types.ObjectId;
  /** As written, e.g. "120/80": a blood pressure is a pair, not a number. */
  bp: string | null;
  pulse: number | null;
  tempF: number | null;
  weightKg: number | null;
  /** Oxygen saturation, percent. */
  spo2: number | null;
  /** Random blood sugar, mg/dL. */
  bloodSugarRandom: number | null;
  complaints: string;
  recordedBy: Types.ObjectId;
  recordedAt: Date;
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
    bp: { type: String, default: null },
    pulse: { type: Number, default: null },
    tempF: { type: Number, default: null },
    weightKg: { type: Number, default: null },
    spo2: { type: Number, default: null },
    bloodSugarRandom: { type: Number, default: null },
    complaints: { type: String, default: '' },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recordedAt: { type: Date, default: () => new Date() },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

vitalSchema.plugin(toJSON);

// One per visit, enforced here rather than hoped for in the service.
vitalSchema.index({ visitId: 1 }, { unique: true });

export const Vital = mongoose.model<IVital>('Vital', vitalSchema, 'vitals');
export default Vital;
