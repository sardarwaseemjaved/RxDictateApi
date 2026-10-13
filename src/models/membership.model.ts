import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { MembershipStatus, Role } from '../shared/roles';

/**
 * What one user may do inside one practice. The role lives here and not on the
 * user, so the same person can be a doctor at her own clinic and a PA at
 * someone else's.
 *
 * Removing a member sets `status` to 'removed' rather than deleting the row:
 * her past actions stay attributable in the audit log.
 */
export interface IMembership {
  userId: Types.ObjectId;
  practiceId: Types.ObjectId;
  role: Role;
  /** Which locations a PA may work at. Ignored for a doctor, who may use any. */
  locationIds: Types.ObjectId[];
  status: MembershipStatus;
  addedBy: Types.ObjectId;
  createdBy: Types.ObjectId;
  removedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MembershipDoc = HydratedDocument<IMembership>;

const membershipSchema = new Schema<IMembership>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    role: { type: String, enum: ['doctor', 'pa', 'patient'], required: true },
    locationIds: { type: [{ type: Schema.Types.ObjectId, ref: 'Location' }], default: [] },
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    removedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

membershipSchema.plugin(toJSON);
membershipSchema.plugin(paginate);

// One row per person per practice, so re-adding a removed PA reactivates the
// row she already had rather than forking her history.
membershipSchema.index({ practiceId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1, status: 1 });

export const Membership = mongoose.model<IMembership, PaginateModel<IMembership>>(
  'Membership',
  membershipSchema,
  'memberships',
);
export default Membership;
