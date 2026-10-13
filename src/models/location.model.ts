import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import { bilingualSubSchema, timingSubSchema } from './subSchemas';
import type { Bilingual, Timing } from '../shared/common';
import type { LocationStatus } from '../shared/location.schema';

/**
 * A place the doctor sees patients. Archived, never deleted: old prescriptions
 * point here, and their letterhead snapshot has to stay resolvable.
 */
export interface ILocation {
  practiceId: Types.ObjectId;
  name: string;
  address: string;
  phone: string;
  timings: Timing[];
  letterhead: Bilingual;
  isDefault: boolean;
  status: LocationStatus;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LocationDoc = HydratedDocument<ILocation>;

const locationSchema = new Schema<ILocation>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    timings: { type: [timingSubSchema], default: [] },
    letterhead: { type: bilingualSubSchema, default: () => ({ en: '', ur: '' }) },
    isDefault: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

locationSchema.plugin(toJSON);
locationSchema.plugin(paginate);

locationSchema.index({ practiceId: 1, status: 1 });

export const Location = mongoose.model<ILocation, PaginateModel<ILocation>>('Location', locationSchema, 'locations');
export default Location;
