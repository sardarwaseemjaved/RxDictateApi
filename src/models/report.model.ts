import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';

/** A scan or photo attached to a patient. The file itself lives in private object storage. */
export interface IReport {
  practiceId: Types.ObjectId;
  patientId: Types.ObjectId;
  fileKey: string;
  kind: string;
  uploadedBy: Types.ObjectId;
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
    fileKey: { type: String, required: true },
    kind: { type: String, default: 'other' },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reportSchema.plugin(toJSON);
reportSchema.plugin(paginate);

reportSchema.index({ practiceId: 1, patientId: 1 });

export const Report = mongoose.model<IReport, PaginateModel<IReport>>('Report', reportSchema, 'reports');
export default Report;
