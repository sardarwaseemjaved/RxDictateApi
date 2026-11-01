import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';

/**
 * A test that was ordered and, later, its result.
 *
 * One row per line of an approved prescription's labs section, written at
 * approval. A revision retires the rows of the version it replaces that have
 * no result or file yet, and writes its own.
 */
export interface ILab {
  practiceId: Types.ObjectId;
  patientId: Types.ObjectId;
  prescriptionId: Types.ObjectId | null;
  name: string;
  result: string;
  fileKey: string | null;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type LabDoc = HydratedDocument<ILab>;

const labSchema = new Schema<ILab>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    prescriptionId: { type: Schema.Types.ObjectId, ref: 'Prescription', default: null },
    name: { type: String, required: true, trim: true },
    result: { type: String, default: '' },
    fileKey: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

labSchema.plugin(toJSON);
labSchema.plugin(paginate);

labSchema.index({ practiceId: 1, patientId: 1 });
// A revision finds the rows the version it replaces ordered.
labSchema.index({ practiceId: 1, prescriptionId: 1 });

export const Lab = mongoose.model<ILab, PaginateModel<ILab>>('Lab', labSchema, 'labs');
export default Lab;
