import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { VisitStatus } from '../shared/visit.schema';

/**
 * A patient on the list for one day at one location.
 *
 * `date` is the Karachi calendar day as `YYYY-MM-DD` rather than a timestamp: a
 * day on a waiting list has no time of day, and storing the instant would make
 * "today's list" depend on who is asking and from where.
 */
export interface IVisit {
  practiceId: Types.ObjectId;
  locationId: Types.ObjectId;
  patientId: Types.ObjectId;
  date: string;
  /** Called out in the waiting room. Per location, per day, from 1, never reused. */
  token: number;
  /** Why they came, in the PA's words. */
  reason: string;
  status: VisitStatus;
  /** When the visit entered its current status, for "went in 6 min ago". */
  statusChangedAt: Date;
  /** Null until vitals are saved against this visit. */
  vitalsRecordedAt: Date | null;
  addedBy: Types.ObjectId;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type VisitDoc = HydratedDocument<IVisit>;

const visitSchema = new Schema<IVisit>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    date: { type: String, required: true },
    token: { type: Number, required: true },
    reason: { type: String, default: '', trim: true },
    status: { type: String, enum: ['waiting', 'with_doctor', 'done'], default: 'waiting' },
    statusChangedAt: { type: Date, default: () => new Date() },
    vitalsRecordedAt: { type: Date, default: null },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

visitSchema.plugin(toJSON);
visitSchema.plugin(paginate);

visitSchema.index({ practiceId: 1, locationId: 1, date: 1, status: 1 });
// Two patients must never be called by the same number on the same day.
visitSchema.index({ practiceId: 1, locationId: 1, date: 1, token: 1 }, { unique: true });

export const Visit = mongoose.model<IVisit, PaginateModel<IVisit>>('Visit', visitSchema, 'visits');
export default Visit;
