import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';

/**
 * Somebody who registered for a seminar or an event, with their consent for
 * their contact to go to the organiser. Name, phone and clinic are copied as
 * they were then, because that is what they agreed to share.
 *
 * Cancelling deletes the row: consent taken back means the organiser no
 * longer has their details. The audit log keeps that it happened, not the
 * details.
 */
export interface IAnnouncementRegistration {
  announcementId: Types.ObjectId;
  userId: Types.ObjectId;
  /** The clinic they registered from. */
  practiceId: Types.ObjectId;
  name: string;
  phone: string;
  clinicName: string;
  consentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type AnnouncementRegistrationDoc = HydratedDocument<IAnnouncementRegistration>;

const announcementRegistrationSchema = new Schema<IAnnouncementRegistration>(
  {
    announcementId: { type: Schema.Types.ObjectId, ref: 'Announcement', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    name: { type: String, default: '' },
    phone: { type: String, required: true },
    clinicName: { type: String, default: '' },
    consentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

announcementRegistrationSchema.plugin(toJSON);
announcementRegistrationSchema.plugin(paginate);

// Once per person per announcement; the organiser's list in the order they came.
announcementRegistrationSchema.index({ announcementId: 1, userId: 1 }, { unique: true });
announcementRegistrationSchema.index({ announcementId: 1, createdAt: 1 });

export const AnnouncementRegistration = mongoose.model<IAnnouncementRegistration, PaginateModel<IAnnouncementRegistration>>(
  'AnnouncementRegistration',
  announcementRegistrationSchema,
  'announcementRegistrations',
);
export default AnnouncementRegistration;
