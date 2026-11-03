import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';

/**
 * For each clinic, doctor and drug: how many approved prescriptions used it and
 * when it was last used. Counted once per approval, never on a save.
 *
 * Only ever read for the doctor it describes, to order that doctor's own
 * suggestions. Nothing here tells anyone else who prescribes what.
 */
export interface IDrugUsage {
  practiceId: Types.ObjectId;
  doctorId: Types.ObjectId;
  drugId: Types.ObjectId;
  count: number;
  lastUsedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type DrugUsageDoc = HydratedDocument<IDrugUsage>;

const drugUsageSchema = new Schema<IDrugUsage>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    drugId: { type: Schema.Types.ObjectId, ref: 'Drug', required: true },
    count: { type: Number, default: 0 },
    lastUsedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

drugUsageSchema.plugin(toJSON);

drugUsageSchema.index({ practiceId: 1, doctorId: 1, drugId: 1 }, { unique: true });

export const DrugUsage = mongoose.model<IDrugUsage>('DrugUsage', drugUsageSchema, 'drugUsage');
export default DrugUsage;
