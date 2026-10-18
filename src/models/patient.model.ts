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
  /** `MR-10001`. What the patient's file is labelled with, and what they quote. */
  mrNo: string;
  name: string;
  phone: string;
  /** `YYYY-MM-DD`, or null when only an age is known. */
  dob: string | null;
  age: number | null;
  sex: Sex;
  allergies: string[];
  /** Asked and none, as opposed to never asked. An empty list cannot say which. */
  noKnownAllergies: boolean;
  conditions: string[];
  /**
   * The Karachi day of this patient's most recent visit, `YYYY-MM-DD`.
   *
   * Derived from the visits collection and kept here on purpose: the patients
   * list sorts by it, and a sort cannot reach into another collection without
   * an aggregation that paging then has to fight. Maintained in one place, by
   * visit.service, with a $max so a visit backdated by the PA cannot pull it
   * backwards.
   */
  lastVisitDate: string | null;
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
    mrNo: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, default: '', trim: true },
    dob: { type: String, default: null },
    age: { type: Number, default: null },
    sex: { type: String, enum: ['male', 'female', 'other'], required: true },
    allergies: { type: [String], default: [] },
    noKnownAllergies: { type: Boolean, default: false },
    conditions: { type: [String], default: [] },
    lastVisitDate: { type: String, default: null },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

patientSchema.plugin(toJSON);
patientSchema.plugin(paginate);

patientSchema.index({ practiceId: 1, phone: 1 });
patientSchema.index({ practiceId: 1, mrNo: 1 }, { unique: true });
// The patients screen's default order once it asks for it.
patientSchema.index({ practiceId: 1, lastVisitDate: -1 });
// A compound text index: the practiceId prefix has to be matched by equality,
// which is exactly how every search runs, and keeps one clinic's names out of
// another's results.
patientSchema.index({ practiceId: 1, name: 'text' });

export const Patient = mongoose.model<IPatient, PaginateModel<IPatient>>('Patient', patientSchema, 'patients');
export default Patient;
