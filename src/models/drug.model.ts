import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { MedicineItem } from '../shared/prescription.schema';

/**
 * The formulary, grown from real use rather than imported: when a prescribed
 * name is not found it is inserted, and the next time it matches. A doctor's
 * working repertoire is 200-400 drugs, which a plain text index handles without
 * help.
 *
 * Not scoped to a practice: a brand name means the same thing in every clinic.
 */
export interface IDrug {
  brand: string;
  generic: string;
  strength: string;
  form: MedicineItem['form'];
  company: string;
  /** Spellings and dictated variants that should match this drug. */
  aliases: string[];
  /** How often it has been prescribed, used to rank search results. */
  useCount: number;
  createdBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DrugDoc = HydratedDocument<IDrug>;

const drugSchema = new Schema<IDrug>(
  {
    brand: { type: String, required: true, trim: true },
    generic: { type: String, default: '', trim: true },
    strength: { type: String, default: '', trim: true },
    form: { type: String, default: 'tab' },
    company: { type: String, default: '', trim: true },
    aliases: { type: [String], default: [] },
    useCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

drugSchema.plugin(toJSON);
drugSchema.plugin(paginate);

drugSchema.index({ brand: 'text', generic: 'text', aliases: 'text' }, { weights: { brand: 10, generic: 5, aliases: 3 } });
drugSchema.index({ brand: 1, strength: 1, form: 1 }, { unique: true });

export const Drug = mongoose.model<IDrug, PaginateModel<IDrug>>('Drug', drugSchema, 'drugs');
export default Drug;
