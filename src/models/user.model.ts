import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';

/**
 * A person, identified by their phone number and nothing else: there is no
 * password anywhere in this product.
 *
 * Deliberately not scoped to a practice. A doctor adds a PA by typing her
 * number, and if she already has an account at another clinic it is the same
 * user with a second membership.
 */
export interface IUser {
  /** E.164, e.g. +923001234567. */
  phone: string;
  name: string;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDoc = HydratedDocument<IUser>;

const userSchema = new Schema<IUser>(
  {
    phone: { type: String, required: true, trim: true },
    name: { type: String, default: '', trim: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.plugin(toJSON);
userSchema.plugin(paginate);

userSchema.index({ phone: 1 }, { unique: true });

export const User = mongoose.model<IUser, PaginateModel<IUser>>('User', userSchema, 'users');
export default User;
