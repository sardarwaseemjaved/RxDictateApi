import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import bcrypt from 'bcryptjs';
import { toJSON } from './plugins';

/**
 * A one-time code issued for a sign-in attempt.
 *
 * Carried over from the passcode model of the previous auth layer, which got
 * this right: codes are stored hashed so a dump of this collection cannot be
 * replayed, wrong guesses are counted, and Mongo reaps expired rows on its own.
 * Keyed by phone because there may be no user yet when the code is sent.
 */
export interface IOtpCode {
  phone: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface OtpCodeMethods {
  isCodeMatch(candidate: string): Promise<boolean>;
}

export type OtpCodeDoc = HydratedDocument<IOtpCode, OtpCodeMethods>;

type OtpCodeModel = mongoose.Model<IOtpCode, Record<string, never>, OtpCodeMethods>;

const otpCodeSchema = new Schema<IOtpCode, OtpCodeModel, OtpCodeMethods>(
  {
    phone: { type: String, required: true },
    codeHash: { type: String, required: true, private: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

otpCodeSchema.plugin(toJSON);

otpCodeSchema.index({ phone: 1 });
// Let Mongo delete expired codes on its own.
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Check a plaintext code against the stored hash. */
otpCodeSchema.methods.isCodeMatch = async function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.codeHash);
};

otpCodeSchema.pre('save', async function (next) {
  if (this.isModified('codeHash')) {
    this.codeHash = await bcrypt.hash(this.codeHash, 8);
  }
  next();
});

export const OtpCode = mongoose.model<IOtpCode, OtpCodeModel>('OtpCode', otpCodeSchema, 'otpCodes');
export default OtpCode;
