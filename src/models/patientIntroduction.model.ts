import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

/**
 * A patient an assistant found by typing their whole phone number, while the
 * patient is not linked to any location that assistant works at.
 *
 * Knowing the full number is taken to mean the patient is at the desk. For a
 * short while that one member may open them and put them on a list at their
 * own location, which links them there for good. Without this, the assistant
 * at a second location would have to register the same person again.
 *
 * Mongo's TTL monitor removes a row once `expiresAt` has passed. Reads check
 * the time as well, because the monitor only runs about once a minute.
 */
export interface IPatientIntroduction {
  practiceId: Types.ObjectId;
  patientId: Types.ObjectId;
  /** The member who typed the number. Nobody else gains anything from it. */
  userId: Types.ObjectId;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type PatientIntroductionDoc = HydratedDocument<IPatientIntroduction>;

const patientIntroductionSchema = new Schema<IPatientIntroduction>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// One row per member per patient: searching again extends it rather than adding another.
patientIntroductionSchema.index({ practiceId: 1, userId: 1, patientId: 1 }, { unique: true });
patientIntroductionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PatientIntroduction = mongoose.model<IPatientIntroduction>(
  'PatientIntroduction',
  patientIntroductionSchema,
  'patientIntroductions',
);
export default PatientIntroduction;
