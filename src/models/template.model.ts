import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { PrescriptionSections } from '../shared/prescription.schema';

/**
 * A saved set of sections a doctor starts a prescription from.
 *
 * Belongs to one doctor within one practice: a template is a prescribing
 * habit, and a colleague's regimen should not turn up on the next page this
 * doctor signs. Two doctors at one clinic each keep their own.
 */
export interface ITemplate {
  practiceId: Types.ObjectId;
  /** The doctor it belongs to. Only that doctor lists, uses or edits it. */
  doctorId: Types.ObjectId;
  name: string;
  sections: PrescriptionSections;
  useCount: number;
  lastUsedAt: Date | null;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TemplateDoc = HydratedDocument<ITemplate>;

const templateSchema = new Schema<ITemplate>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true },
    // Validated by zod on the way in, so Mixed here, as with a medicine's
    // dose pattern.
    sections: { type: Schema.Types.Mixed, default: () => ({}) },
    useCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

templateSchema.plugin(toJSON);
templateSchema.plugin(paginate);

// Every read is one doctor's templates in one practice, most used first.
templateSchema.index({ practiceId: 1, doctorId: 1, useCount: -1 });

export const Template = mongoose.model<ITemplate, PaginateModel<ITemplate>>('Template', templateSchema, 'templates');
export default Template;
