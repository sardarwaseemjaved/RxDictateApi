import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { PrescriptionSections } from '../shared/prescription.schema';

/**
 * A saved set of sections the doctor can start a prescription from. Created now
 * with its index so nothing is renamed when the routes stop returning 501.
 */
export interface ITemplate {
  practiceId: Types.ObjectId;
  name: string;
  sections: PrescriptionSections;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TemplateDoc = HydratedDocument<ITemplate>;

const templateSchema = new Schema<ITemplate>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    name: { type: String, required: true, trim: true },
    sections: { type: Schema.Types.Mixed, default: () => ({}) },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

templateSchema.plugin(toJSON);
templateSchema.plugin(paginate);

templateSchema.index({ practiceId: 1 });

export const Template = mongoose.model<ITemplate, PaginateModel<ITemplate>>('Template', templateSchema, 'templates');
export default Template;
