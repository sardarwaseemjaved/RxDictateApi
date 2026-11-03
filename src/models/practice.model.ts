import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { PracticeFeatures, PracticeSettings } from '../shared/practice.schema';
import { organisationTypeSchema, type OrganisationType } from '../shared/roles';

/**
 * The tenant. Built for one doctor today, but every other record points at a
 * practice so the same code serves a doctor with two locations or a clinic with
 * several doctors later. The UI never uses the word.
 *
 * A practice is an organisation, and `type` says which kind. Every practice
 * made before types existed is a clinic, and the boot backfill writes that
 * down. The letterhead fields and counters mean nothing to the platform and
 * stay at their defaults there.
 */
export interface IPractice {
  type: OrganisationType;
  name: string;
  ownerId: Types.ObjectId;
  pmdcNo: string;
  qualifications: string[];
  /** "Consultant Physician", printed under the doctor's name. */
  speciality: string;
  features: PracticeFeatures;
  settings: PracticeSettings;
  /**
   * The last prescription number handed out. Only ever moved by an atomic
   * $inc: a read-then-write here puts a duplicate number on a legal document.
   */
  rxCounter: number;
  /**
   * The last MR number handed out. Starts at 10000, so the first patient is
   * MR-10001 - a five-digit number looks like a record number and a one-digit
   * one looks like a mistake. Moved only by an atomic $inc, like rxCounter.
   */
  mrCounter: number;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PracticeDoc = HydratedDocument<IPractice>;

const practiceSchema = new Schema<IPractice>(
  {
    type: { type: String, enum: organisationTypeSchema.options, default: 'clinic' },
    name: { type: String, required: true, trim: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pmdcNo: { type: String, default: '', trim: true },
    qualifications: { type: [String], default: [] },
    speciality: { type: String, default: '', trim: true },
    features: {
      voice: { type: Boolean, default: true },
      templates: { type: Boolean, default: false },
    },
    settings: {
      audioRetentionDays: { type: Number, default: 30 },
    },
    rxCounter: { type: Number, default: 0 },
    mrCounter: { type: Number, default: 10000 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

practiceSchema.plugin(toJSON);
practiceSchema.plugin(paginate);

practiceSchema.index({ ownerId: 1 });
// There is exactly one platform, and two runs of platform:init at once cannot make a second.
practiceSchema.index({ type: 1 }, { unique: true, partialFilterExpression: { type: 'platform' } });

export const Practice = mongoose.model<IPractice, PaginateModel<IPractice>>('Practice', practiceSchema, 'practices');
export default Practice;
