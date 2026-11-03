import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';
import { SETTING_KEYS, settingLayerSchema, type SettingKey, type SettingLayer } from '../shared/settings';

/**
 * One value of one setting at one layer. The registry in src/shared/settings.ts
 * says what each key may hold and who may set it; a row only exists where
 * somebody did.
 *
 * - platform: no organisation, no user. Applies to everyone.
 * - organisation: the organisation's id. Applies to everyone in it.
 * - user: the organisation's id and the user's. One person in one clinic, so
 *   somebody who works at two clinics can choose differently at each.
 *
 * Taking a value away deletes its row: there is nothing to keep, and the
 * audit log has what it was.
 */
export interface ISetting {
  layer: SettingLayer;
  organisationId: Types.ObjectId | null;
  userId: Types.ObjectId | null;
  key: SettingKey;
  value: unknown;
  /** Whether the layers below may change it. Only on platform and organisation rows of a lockable key. */
  locked: boolean;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type SettingDoc = HydratedDocument<ISetting>;

const settingSchema = new Schema<ISetting>(
  {
    layer: { type: String, enum: settingLayerSchema.options, required: true },
    organisationId: { type: Schema.Types.ObjectId, ref: 'Practice', default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    key: { type: String, enum: SETTING_KEYS, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    locked: { type: Boolean, default: false },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, minimize: false },
);

settingSchema.plugin(toJSON);

// One value per key per layer. Also the index that working out a caller's
// settings reads: the platform's rows, their organisation's and their own.
settingSchema.index({ layer: 1, organisationId: 1, userId: 1, key: 1 }, { unique: true });

export const Setting = mongoose.model<ISetting>('Setting', settingSchema, 'settings');
export default Setting;
