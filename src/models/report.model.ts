import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { ReportType } from '../shared/report.schema';

/**
 * A lab sheet, a scan or an old prescription, attached to a patient.
 *
 * The pages live in private object storage and only their keys are here - a
 * report photographed on a phone is several megabytes a page, and none of it
 * belongs in a document the API reads on every list.
 */
export interface IReport {
  practiceId: Types.ObjectId;
  patientId: Types.ObjectId;
  /** The visit it was brought to, when it was brought to one. */
  visitId: Types.ObjectId | null;
  type: ReportType;
  testName: string;
  /** The day the test was done, `YYYY-MM-DD`, which is rarely the upload day. */
  testDate: string;
  pageKeys: string[];
  uploadedBy: Types.ObjectId;
  /** Null until the doctor has looked at it. */
  reviewedAt: Date | null;
  reviewedBy: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ReportDoc = HydratedDocument<IReport>;

const reportSchema = new Schema<IReport>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit', default: null },
    type: { type: String, enum: ['lab', 'imaging', 'old_prescription', 'other'], default: 'other' },
    testName: { type: String, required: true, trim: true },
    testDate: { type: String, required: true },
    pageKeys: { type: [String], default: [] },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reportSchema.plugin(toJSON);
reportSchema.plugin(paginate);

reportSchema.index({ practiceId: 1, patientId: 1, createdAt: -1 });

export const Report = mongoose.model<IReport, PaginateModel<IReport>>('Report', reportSchema, 'reports');
export default Report;
