import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';

/**
 * The one invite a patient record has: a new one overwrites the old, which is
 * what replaces its code. The row outlives its code, because the times on it
 * are what hold the limits: one invite a day, and one automatic invite ever.
 *
 * The code itself is never stored, only its hash.
 */
export interface IPatientInvite {
  practiceId: Types.ObjectId;
  patientId: Types.ObjectId;
  /** SHA-256 of the code. Null once it has been voided. Kept once used, so a retry can be recognised. */
  codeHash: string | null;
  expiresAt: Date | null;
  usedAt: Date | null;
  lastSentAt: Date | null;
  /** Set once and never cleared: an automatic invite goes out once per record, ever. */
  autoSentAt: Date | null;
  sentBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PatientInviteDoc = HydratedDocument<IPatientInvite>;

const patientInviteSchema = new Schema<IPatientInvite>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    codeHash: { type: String, default: null },
    expiresAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    lastSentAt: { type: Date, default: null },
    autoSentAt: { type: Date, default: null },
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

patientInviteSchema.plugin(toJSON);

patientInviteSchema.index({ patientId: 1 }, { unique: true });
// A person arrives with a code and nothing else, across every clinic.
patientInviteSchema.index({ codeHash: 1 }, { unique: true, partialFilterExpression: { codeHash: { $type: 'string' } } });

export const PatientInvite = mongoose.model<IPatientInvite>('PatientInvite', patientInviteSchema, 'patientInvites');
export default PatientInvite;
