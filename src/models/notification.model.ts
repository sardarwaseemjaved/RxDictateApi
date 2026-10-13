import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { NotificationType } from '../shared/notification.schema';

/**
 * Written from the first day and read by nothing yet. The point is that turning
 * the inbox on later is a screen, not a backfill.
 */
export interface INotification {
  practiceId: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationType;
  refId: Types.ObjectId | null;
  title: string;
  body: string;
  readAt: Date | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDoc = HydratedDocument<INotification>;

const notificationSchema = new Schema<INotification>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, required: true },
    refId: { type: Schema.Types.ObjectId, default: null },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    readAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

notificationSchema.plugin(toJSON);
notificationSchema.plugin(paginate);

notificationSchema.index({ userId: 1, readAt: 1 });

export const Notification = mongoose.model<INotification, PaginateModel<INotification>>(
  'Notification',
  notificationSchema,
  'notifications',
);
export default Notification;
