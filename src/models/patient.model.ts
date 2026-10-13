import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { Sex } from '../shared/common';

/**
 * Practice-wide on purpose: a patient first seen at one location must be
 * findable at another without being typed in twice.
 *
 * Most patients do not know their date of birth, so `age` is stored as typed
 * when there is no `dob`. When there is one, age is derived from it on read.
 */
export interface IPatient {
  practiceId: Types.ObjectId;
  name: string;
  phone: string;
  /** `YYYY-MM-DD`, or null when only an age is known. */
  dob: string | null;
  age: number | null;
  sex: Sex;
  addedBy: Types.ObjectId;
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PatientDoc = HydratedDocument<IPatient>;

const patientSchema = new Schema<IPatient>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    dob: { type: String, default: null },
    age: { type: Number, default: null },
    sex: { type: String, enum: ['male', 'female', 'other'], required: true },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

patientSchema.plugin(toJSON);
patientSchema.plugin(paginate);

patientSchema.index({ practiceId: 1, phone: 1 });
// A compound text index: the practiceId prefix has to be matched by equality,
// which is exactly how every search runs, and keeps one clinic's names out of
// another's results.
patientSchema.index({ practiceId: 1, name: 'text' });

export const Patient = mongoose.model<IPatient, PaginateModel<IPatient>>('Patient', patientSchema, 'patients');
export default Patient;
