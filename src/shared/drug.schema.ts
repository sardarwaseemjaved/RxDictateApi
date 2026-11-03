import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema } from './common';
import { dosePatternSchema, medicineFormSchema, medicineItemSchema, medicineTimingSchema } from './prescription.schema';

/**
 * - `national`: the catalog, which comes only from the DRAP import.
 * - `clinic`: one clinic's own item, seen only inside that clinic.
 * - `doctor`: one doctor's, seen only by that doctor in that clinic.
 */
export const drugScopeSchema = z.enum(['national', 'clinic', 'doctor']);
export type DrugScope = z.infer<typeof drugScopeSchema>;

export const drugSourceSchema = z.enum(['drapImport', 'clinic', 'typed']);
export type DrugSource = z.infer<typeof drugSourceSchema>;

/** Only `active` and `discontinued` are used yet. */
export const drugStatusSchema = z.enum(['pending', 'active', 'rejected', 'discontinued']);
export type DrugStatus = z.infer<typeof drugStatusSchema>;

export const drugViewSchema = z.object({
  id: objectIdSchema,
  brand: z.string(),
  /** The composition, as DRAP writes it: "Paracetamol 500mg + Caffeine 65mg". */
  generic: z.string(),
  strength: z.string(),
  form: medicineFormSchema,
  /** Such as 10x10. */
  pack: z.string(),
  company: z.string(),
  aliases: z.array(z.string()),
  drapRegNo: z.string().nullable(),
  scope: drugScopeSchema,
  source: drugSourceSchema,
  status: drugStatusSchema,
  /** False only for what a doctor typed that nothing else matched. */
  verified: z.boolean(),
});
export type DrugView = z.infer<typeof drugViewSchema>;

/**
 * How an owner usually prescribes a drug: the same shapes as a medicine line.
 * Only what they said is kept. A line's defaults would invent a dose nobody
 * chose, so a field left out stays out.
 */
export const usualSchema = z.object({
  pattern: dosePatternSchema.optional(),
  timing: medicineTimingSchema.optional(),
  durationDays: medicineItemSchema.shape.durationDays.unwrap().optional(),
  instructionEn: medicineItemSchema.shape.instructionEn.unwrap().optional(),
  instructionUr: medicineItemSchema.shape.instructionUr.unwrap().optional(),
});
export type Usual = z.infer<typeof usualSchema>;

/**
 * `GET /drugs`: the same path, `q` and `limit` as ever. The server applies the
 * caller's effective `medicines.source`. `everywhere=true` searches as `all`
 * for this one request, which is the app's "Search all medicines" when `myList`
 * finds nothing; it never changes the setting.
 */
export const searchDrugsQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  everywhere: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type SearchDrugsQuery = z.infer<typeof searchDrugsQuerySchema>;

/** One result of `GET /drugs`. */
export const drugSuggestionSchema = drugViewSchema.extend({
  inMyList: z.boolean(),
  inClinicList: z.boolean(),
  /** From the doctor's own list, otherwise from the clinic's, otherwise null. */
  usual: usualSchema.nullable(),
});
export type DrugSuggestion = z.infer<typeof drugSuggestionSchema>;

const drugFields = {
  brand: z.string().trim().min(1).max(200),
  generic: z.string().trim().max(500),
  strength: z.string().trim().max(60),
  form: medicineFormSchema,
  pack: z.string().trim().max(60),
  company: z.string().trim().max(200),
};

/**
 * `POST /drugs`: a medicine nothing else has, for the clinic's list or the
 * doctor's own. An exact duplicate the caller can already see is reused and put
 * on that list instead.
 */
export const createDrugBodySchema = z.object({
  brand: drugFields.brand,
  generic: drugFields.generic.default(''),
  strength: drugFields.strength.default(''),
  form: drugFields.form.default('tab'),
  pack: drugFields.pack.default(''),
  company: drugFields.company.default(''),
  for: z.enum(['clinic', 'me']),
});
export type CreateDrugBody = z.infer<typeof createDrugBodySchema>;

/** `PATCH /drugs/:id`. Built without defaults, so only what is sent changes. */
export const updateDrugBodySchema = z
  .object(drugFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateDrugBody = z.infer<typeof updateDrugBodySchema>;

/** Whose list: the caller's own in this clinic, or the clinic's. */
export const drugListOwnerSchema = z.enum(['me', 'clinic']);
export type DrugListOwner = z.infer<typeof drugListOwnerSchema>;

export const drugListParamsSchema = z.object({ owner: drugListOwnerSchema });

export const drugListItemParamsSchema = z.object({ owner: drugListOwnerSchema, drugId: objectIdSchema });
export type DrugListItemParams = z.infer<typeof drugListItemParamsSchema>;

export const listDrugListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
});
export type ListDrugListQuery = z.infer<typeof listDrugListQuerySchema>;

/**
 * `PUT /drug-lists/:owner/items/:drugId`. Leaving `usual` out keeps what is
 * there, and null takes it away.
 */
export const putDrugListItemBodySchema = z.object({ usual: usualSchema.nullable().optional() });
export type PutDrugListItemBody = z.infer<typeof putDrugListItemBodySchema>;

export const drugListItemViewSchema = z.object({
  drug: drugViewSchema,
  usual: usualSchema.nullable(),
  addedAt: z.coerce.date(),
});
export type DrugListItemView = z.infer<typeof drugListItemViewSchema>;
