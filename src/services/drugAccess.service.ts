import type { FilterQuery, Types } from 'mongoose';
import { Drug, normaliseName, type DrugDoc, type IDrug } from '../models';
import type { Scope } from '../core/db';
import type { DrugView } from '../shared/drug.schema';

/**
 * What a row looks like to the apps, and which rows a caller can see. In one
 * place, so no search or list can reach another clinic's items or another
 * doctor's typed rows by forgetting a filter.
 */

export const toDrugView = (drug: DrugDoc): DrugView => ({
  id: String(drug._id),
  brand: drug.brand,
  generic: drug.generic,
  strength: drug.strength,
  form: drug.form,
  pack: drug.pack,
  company: drug.company,
  aliases: drug.aliases,
  drapRegNo: drug.drapRegNo,
  scope: drug.scope,
  source: drug.source,
  status: drug.status,
  verified: drug.source !== 'typed',
});

export const nationalRows: FilterQuery<IDrug> = { scope: 'national', practiceId: null, ownerId: null };

export const clinicRows = (scope: Scope): FilterQuery<IDrug> => ({
  scope: 'clinic',
  practiceId: scope.practiceId,
  ownerId: null,
});

export const ownRows = (scope: Scope): FilterQuery<IDrug> => ({
  scope: 'doctor',
  practiceId: scope.practiceId,
  ownerId: scope.actorId,
});

/** Everything this person can see, whatever its status. */
export const visibleTo = (scope: Scope): FilterQuery<IDrug>[] => [nationalRows, clinicRows(scope), ownRows(scope)];

export const findVisibleDrug = async (scope: Scope, id: Types.ObjectId | string): Promise<DrugDoc | null> =>
  Drug.findOne({ _id: id, $or: visibleTo(scope) });

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Anchored and case-sensitive against keys already in lower case, which is the
 * one kind of regex an index can answer by walking from the prefix.
 */
export const prefixOf = (typed: string): RegExp => new RegExp(`^${escapeRegex(normaliseName(typed))}`);
