import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';

/**
 * Refresh tokens are kept server side so a sign-out can actually revoke one and
 * so a stolen token can be burned. Access tokens stay stateless.
 *
 * Infrastructure rather than a clinical record, which is why there is no
 * practiceId here: a token belongs to a person, not to a practice.
 */
export interface IRefreshToken {
  token: string;
  userId: Types.ObjectId;
  expires: Date;
  blacklisted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type RefreshTokenDoc = HydratedDocument<IRefreshToken>;

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    token: { type: String, required: true, private: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expires: { type: Date, required: true },
    blacklisted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

refreshTokenSchema.plugin(toJSON);

refreshTokenSchema.index({ token: 1 });
refreshTokenSchema.index({ userId: 1 });
// An expired refresh token is of no use to anyone, so Mongo clears it out.
refreshTokenSchema.index({ expires: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = mongoose.model<IRefreshToken>('RefreshToken', refreshTokenSchema, 'refreshTokens');
export default RefreshToken;
