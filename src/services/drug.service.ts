import type { Types } from 'mongoose';
import { Drug, type DrugDoc } from '../models';
import type { DrugView, SearchDrugsQuery } from '../shared/drug.schema';
import type { MedicineItem } from '../shared/prescription.schema';

export const toDrugView = (drug: DrugDoc): DrugView => ({
  id: String(drug._id),
  brand: drug.brand,
  generic: drug.generic,
  strength: drug.strength,
  form: drug.form,
  company: drug.company,
  aliases: drug.aliases,
});

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Text index first, prefix match second.
 *
 * Mongo's text search matches whole words, so typing "pana" would find nothing
 * while "panadol" finds everything. At 200-400 drugs the fallback scan costs
 * nothing, and between them they behave the way a type-ahead should.
 */
export const searchDrugs = async (query: SearchDrugsQuery): Promise<DrugView[]> => {
  const { q, limit } = query;

  const byText = await Drug.find({ $text: { $search: q } })
    .sort({ useCount: -1 })
    .limit(limit);
  if (byText.length > 0) {
    return byText.map(toDrugView);
  }

  const prefix = { $regex: `^${escapeRegex(q)}`, $options: 'i' };
  const byPrefix = await Drug.find({ $or: [{ brand: prefix }, { generic: prefix }, { aliases: prefix }] })
    .sort({ useCount: -1 })
    .limit(limit);

  return byPrefix.map(toDrugView);
};

/**
 * The formulary grows from use rather than from an import: a drug the doctor
 * prescribes for the first time is inserted here, and the next time anyone says
 * it, it matches.
 */
export const findOrCreateDrug = async (
  medicine: Pick<MedicineItem, 'name' | 'strength' | 'form'>,
  actorId: Types.ObjectId,
): Promise<DrugDoc> => {
  const brand = medicine.name.trim();
  const strength = medicine.strength.trim();

  const existing = await Drug.findOneAndUpdate(
    { brand, strength, form: medicine.form },
    { $inc: { useCount: 1 } },
    { new: true },
  );
  if (existing) {
    return existing;
  }

  // Upsert rather than create: two doctors prescribing the same new drug at the
  // same moment would otherwise race on the unique index.
  const created = await Drug.findOneAndUpdate(
    { brand, strength, form: medicine.form },
    {
      $setOnInsert: { brand, strength, form: medicine.form, generic: '', company: '', aliases: [], createdBy: actorId },
      $inc: { useCount: 1 },
    },
    { new: true, upsert: true },
  );
  return created;
};

export default { searchDrugs, findOrCreateDrug, toDrugView };
