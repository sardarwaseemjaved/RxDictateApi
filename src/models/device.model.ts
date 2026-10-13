import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';

/** Where to send a push once there is anything to push. Not scoped to a practice: a phone belongs to a person. */
export interface IDevice {
  userId: Types.ObjectId;
  pushToken: string;
  platform: 'ios' | 'android';
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DeviceDoc = HydratedDocument<IDevice>;

const deviceSchema = new Schema<IDevice>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    pushToken: { type: String, required: true },
    platform: { type: String, enum: ['ios', 'android'], required: true },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);

deviceSchema.plugin(toJSON);

deviceSchema.index({ userId: 1 });
deviceSchema.index({ pushToken: 1 }, { unique: true });

export const Device = mongoose.model<IDevice>('Device', deviceSchema, 'devices');
export default Device;
