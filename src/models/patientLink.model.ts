import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';
import type { PortalLinkKind } from '../shared/portal.schema';

/** Why a link was removed. Who removed it is `removedBy`. */
export type PatientLinkEndReason = 'patient' | 'clinic' | 'phoneChanged' | 'blocked';

/** What a person still holds. A removed link is history: it serves nothing and is never revived. */
export const LIVE_LINK_STATUSES = ['active', 'dormant'] as const;

/**
 * One user holding one patient record in one clinic.
 *
 * Not a membership, and it gives no clinic rights: no clinic route reads this
 * collection to let anybody in. The same user may hold many, including records
 * at different clinics. Removed rows are kept, so a link ended by a changed
 * phone stays explicable; a new link is a new row.
 */
export interface IPatientLink {
  userId: Types.ObjectId;
  patientId: Types.ObjectId;
  practiceId: Types.ObjectId;
  /** Which kind of code made it, or last revived it. */
  madeBy: PortalLinkKind;
  linkedAt: Date;
  /** Moved at most once a day. See PORTAL_LINK_DORMANT_DAYS. */
  lastUsedAt: Date;
  status: 'active' | 'dormant' | 'removed';
  removedBy: Types.ObjectId | null;
  removedAt: Date | null;
  removedReason: PatientLinkEndReason | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PatientLinkDoc = HydratedDocument<IPatientLink>;

const patientLinkSchema = new Schema<IPatientLink>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    madeBy: { type: String, enum: ['invite', 'prescription'], required: true },
    linkedAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true },
    status: { type: String, enum: ['active', 'dormant', 'removed'], default: 'active' },
    removedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    removedAt: { type: Date, default: null },
    removedReason: { type: String, enum: ['patient', 'clinic', 'phoneChanged', 'blocked'], default: null },
  },
  { timestamps: true },
);

patientLinkSchema.plugin(toJSON);

// A person's links, for the patient's area and the count on /me.
patientLinkSchema.index({ userId: 1, status: 1 });
// A record's links, for the clinic's controls and for ending them.
patientLinkSchema.index({ practiceId: 1, patientId: 1, status: 1 });
/**
 * At most one active link per record, held by the database rather than by a
 * check two simultaneous requests would both pass.
 */
patientLinkSchema.index({ patientId: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });

export const PatientLink = mongoose.model<IPatientLink>('PatientLink', patientLinkSchema, 'patientLinks');
export default PatientLink;
