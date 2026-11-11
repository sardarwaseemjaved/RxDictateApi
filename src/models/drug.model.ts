import mongoose, { Schema, type HydratedDocument } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import {
  drugScopeSchema,
  drugSourceSchema,
  drugStatusSchema,
  type DrugScope,
  type DrugSource,
  type DrugStatus,
} from '../shared/drug.schema';
import { medicineFormSchema, type MedicineItem } from '../shared/prescription.schema';

/**
 * Medicines, in three scopes:
 *
 * - `national`: the catalog, from the DRAP import and nowhere else, so one
 *   doctor's typo never shows to another.
 * - `clinic`: an item only this clinic has, seen only inside it.
 * - `doctor`: a medicine one doctor typed that nothing else matched, seen only
 *   by that doctor in that clinic, and shown as unverified.
 *
 * A prescription keeps its own copy of every line, so changing or discontinuing
 * a row here never changes a prescription.
 */
export interface IDrug {
  brand: string;
  /** The composition, as DRAP writes it: "Paracetamol 500mg + Caffeine 65mg". */
  generic: string;
  strength: string;
  form: MedicineItem['form'];
  /** As the label says it, such as 10x10. */
  pack: string;
  company: string;
  /** Spellings and dictated variants that should match this drug. */
  aliases: string[];
  drapRegNo: string | null;
  source: DrugSource;
  scope: DrugScope;
  status: DrugStatus;
  /** The clinic, on a `clinic` or `doctor` row. */
  practiceId: mongoose.Types.ObjectId | null;
  /** The doctor, on a `doctor` row. */
  ownerId: mongoose.Types.ObjectId | null;
  /**
   * The company that owns a national row: its own product, or a DRAP row it
   * claimed. Only ever set by approving a submission. Not `practiceId`, which
   * would take the row out of the national catalog.
   */
  companyId: mongoose.Types.ObjectId | null;
  /** On a clinic's item merged into a national row: that row. The item itself is discontinued. */
  mergedIntoId: mongoose.Types.ObjectId | null;
  /** For sorting by name. */
  brandKey: string;
  /** Brand, strength and form without case or spacing: what makes two rows the same medicine. */
  identityKey: string;
  /** Each name from its start, lower case: what a prefix search reads. */
  nameKeys: string[];
  /** Each name from each later word: what "contains" means, without a scan. */
  wordKeys: string[];
  createdBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type DrugDoc = HydratedDocument<IDrug>;

/** The same on the way in and on the way out of a search. */
export const normaliseName = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

const withoutSpacing = (text: string): string => text.toLowerCase().replace(/\s+/g, '');

export const identityKeyOf = ({ brand, strength, form }: Pick<IDrug, 'brand' | 'strength' | 'form'>): string =>
  `${withoutSpacing(brand)}|${withoutSpacing(strength)}|${form}`;

/** A name from the second word on, the third word on, and so on. */
const laterWords = (name: string): string[] =>
  [...name.matchAll(/[^\s,+/()-]+/g)].slice(1).map((match) => name.slice(match.index));

/**
 * Every key worked out from what a row says. Spread into every write that sets
 * those fields, because a bulk write or an upsert runs no hook.
 */
export const drugKeys = (
  drug: Pick<IDrug, 'brand' | 'generic' | 'strength' | 'form'> & { aliases?: string[] },
): Pick<IDrug, 'brandKey' | 'identityKey' | 'nameKeys' | 'wordKeys'> => {
  const brandKey = normaliseName(drug.brand);
  const strength = normaliseName(drug.strength);
  const names = [brandKey, normaliseName(drug.generic), ...(drug.aliases ?? []).map(normaliseName)].filter(Boolean);
  return {
    brandKey,
    identityKey: identityKeyOf(drug),
    // Brand with strength, so "panadol 500" still finds it while typing on.
    nameKeys: [...new Set([...names, ...(strength ? [`${brandKey} ${strength}`] : [])])],
    wordKeys: [...new Set(names.flatMap(laterWords))],
  };
};

const drugSchema = new Schema<IDrug>(
  {
    brand: { type: String, required: true, trim: true },
    generic: { type: String, default: '', trim: true },
    strength: { type: String, default: '', trim: true },
    form: { type: String, enum: medicineFormSchema.options, default: 'tab' },
    pack: { type: String, default: '', trim: true },
    company: { type: String, default: '', trim: true },
    aliases: { type: [String], default: [] },
    drapRegNo: { type: String, default: null, trim: true },
    source: { type: String, enum: drugSourceSchema.options, required: true },
    scope: { type: String, enum: drugScopeSchema.options, required: true },
    status: { type: String, enum: drugStatusSchema.options, default: 'active' },
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', default: null },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    companyId: { type: Schema.Types.ObjectId, ref: 'Practice', default: null },
    mergedIntoId: { type: Schema.Types.ObjectId, ref: 'Drug', default: null },
    brandKey: { type: String, required: true },
    identityKey: { type: String, required: true },
    nameKeys: { type: [String], default: [] },
    wordKeys: { type: [String], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

drugSchema.plugin(toJSON);
drugSchema.plugin(paginate);

// The type-ahead. Every search names a scope, a status and an owner, so each of
// these narrows to one owner's rows and then walks the keys from the prefix.
drugSchema.index({ scope: 1, status: 1, practiceId: 1, ownerId: 1, nameKeys: 1 });
drugSchema.index({ scope: 1, status: 1, practiceId: 1, ownerId: 1, wordKeys: 1 });

// Linking a line that was typed to the row it names.
drugSchema.index({ identityKey: 1 });

// A company's own products, by name.
drugSchema.index({ companyId: 1, brandKey: 1 }, { partialFilterExpression: { companyId: { $type: 'objectId' } } });

// One row per product in the catalog, and one per medicine per owner elsewhere.
drugSchema.index({ drapRegNo: 1 }, { unique: true, partialFilterExpression: { drapRegNo: { $type: 'string' } } });
drugSchema.index({ practiceId: 1, identityKey: 1 }, { unique: true, partialFilterExpression: { scope: 'clinic' } });
drugSchema.index(
  { practiceId: 1, ownerId: 1, identityKey: 1 },
  { unique: true, partialFilterExpression: { scope: 'doctor' } },
);

/** What the collection was indexed by when it grew from typing. */
export const RETIRED_DRUG_INDEXES = ['brand_1_strength_1_form_1', 'brand_text_generic_text_aliases_text'];

export const Drug = mongoose.model<IDrug, PaginateModel<IDrug>>('Drug', drugSchema, 'drugs');
export default Drug;
