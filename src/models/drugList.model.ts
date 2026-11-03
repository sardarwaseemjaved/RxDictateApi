import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { toJSON } from './plugins';
import type { Usual } from '../shared/drug.schema';

export interface IDrugListItem {
  drugId: Types.ObjectId;
  addedAt: Date;
  addedBy: Types.ObjectId;
  /** How this owner usually prescribes it, or null. */
  usual: Usual | null;
}

/**
 * One list per owner: a doctor in a clinic, or the clinic itself (`ownerId`
 * null). "My list" means the doctor's own and their clinic's, together.
 *
 * A discontinued drug stays on a list, so its owner sees why it stopped being
 * suggested and can take it off.
 */
export interface IDrugList {
  practiceId: Types.ObjectId;
  ownerId: Types.ObjectId | null;
  items: IDrugListItem[];
  createdAt: Date;
  updatedAt: Date;
}

export type DrugListDoc = HydratedDocument<IDrugList>;

const drugListItemSchema = new Schema<IDrugListItem>(
  {
    drugId: { type: Schema.Types.ObjectId, ref: 'Drug', required: true },
    addedAt: { type: Date, required: true },
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    usual: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false, minimize: false },
);

const drugListSchema = new Schema<IDrugList>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    items: { type: [drugListItemSchema], default: [] },
  },
  { timestamps: true },
);

drugListSchema.plugin(toJSON);

drugListSchema.index({ practiceId: 1, ownerId: 1 }, { unique: true });

export const DrugList = mongoose.model<IDrugList>('DrugList', drugListSchema, 'drugLists');
export default DrugList;
