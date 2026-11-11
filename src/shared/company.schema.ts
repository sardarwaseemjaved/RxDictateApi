import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema, phoneSchema } from './common';
import { citySchema, provinceSchema } from './location.schema';
import { medicineFormSchema } from './prescription.schema';
import { organisationStatusSchema } from './roles';
import { drugStatusSchema } from './drug.schema';
import { submissionSummarySchema } from './submissionStatus';

/* ------------------------------------------------------------------ *
 * Companies, as RxDictate sees and makes them
 * ------------------------------------------------------------------ */

/**
 * A medicine company: an organisation of type `company`, in the same
 * collection as clinics, so its id is a practice id and X-Practice-Id names it.
 */
export const companyViewSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  address: z.string(),
  province: provinceSchema.nullable(),
  city: z.string().nullable(),
  /** Securities and Exchange Commission of Pakistan company registration number. */
  secpRegNo: z.string(),
  /** Drug Regulatory Authority of Pakistan licence number. */
  drapLicenceNo: z.string(),
  contactPhone: phoneSchema.nullable(),
  status: organisationStatusSchema,
  suspendedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type CompanyView = z.infer<typeof companyViewSchema>;

const companyFields = {
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500),
  province: provinceSchema.nullable(),
  city: citySchema.nullable(),
  secpRegNo: z.string().trim().min(1).max(60),
  drapLicenceNo: z.string().trim().min(1).max(60),
  contactPhone: phoneSchema.nullable(),
};

/**
 * `POST /companies`: the company, checked by RxDictate beforehand, and the
 * person who will run it. That phone gets a `companyAdmin` membership - a user
 * is made if nobody has signed in with it - and an SMS saying so.
 */
export const createCompanyBodySchema = z.object({
  name: companyFields.name,
  address: companyFields.address.default(''),
  province: companyFields.province.default(null),
  city: companyFields.city.default(null),
  secpRegNo: companyFields.secpRegNo,
  drapLicenceNo: companyFields.drapLicenceNo,
  contactPhone: companyFields.contactPhone.default(null),
  admin: z.object({
    phone: phoneSchema,
    name: z.string().trim().min(1).max(120).optional(),
  }),
});
export type CreateCompanyBody = z.infer<typeof createCompanyBodySchema>;

/** `PATCH /companies/:id`. Status changes only through suspend and reactivate. */
export const updateCompanyBodySchema = z
  .object(companyFields)
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateCompanyBody = z.infer<typeof updateCompanyBodySchema>;

/** `GET /companies`: by name, oldest first. `q` matches anywhere in the name, ignoring case. */
export const listCompaniesQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  status: organisationStatusSchema.optional(),
});
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

/* ------------------------------------------------------------------ *
 * A company's products
 * ------------------------------------------------------------------ */

/**
 * A product as a company sends it: the DRAP importer's columns, with the form
 * as one of ours. Nothing here is live until a reviewer approves it.
 */
export const productFieldsSchema = z.object({
  brand: z.string().trim().min(1).max(200),
  /** As DRAP writes it: "Paracetamol 500mg + Caffeine 65mg". */
  composition: z.string().trim().max(500).default(''),
  strength: z.string().trim().max(60).default(''),
  form: medicineFormSchema.default('tab'),
  /** Such as 10x10. */
  pack: z.string().trim().max(60).default(''),
  registrationNo: z.string().trim().min(1).max(60),
});
export type ProductFields = z.infer<typeof productFieldsSchema>;

/** `POST /company/products`: a new product, sent as a `drug.create` submission. */
export const createProductBodySchema = productFieldsSchema;
export type CreateProductBody = z.infer<typeof createProductBodySchema>;

/**
 * `PATCH /company/products/:id`: a change, sent as a `drug.update`
 * submission. What doctors see stays as it is until it is approved. The
 * registration number is what the product is, so it does not change here.
 */
export const updateProductBodySchema = z
  .object({
    brand: productFieldsSchema.shape.brand,
    composition: z.string().trim().max(500),
    strength: z.string().trim().max(60),
    form: medicineFormSchema,
    pack: z.string().trim().max(60),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;

/** `POST /company/products/claim`: a DRAP-imported product this company makes, by its registration number. */
export const claimProductBodySchema = z.object({
  registrationNo: productFieldsSchema.shape.registrationNo,
});
export type ClaimProductBody = z.infer<typeof claimProductBodySchema>;

/** One of a company's live products, as the company sees it. Never any usage. */
export const companyProductViewSchema = z.object({
  id: objectIdSchema,
  brand: z.string(),
  composition: z.string(),
  strength: z.string(),
  form: medicineFormSchema,
  pack: z.string(),
  registrationNo: z.string().nullable(),
  status: drugStatusSchema,
  latestSubmission: submissionSummarySchema.nullable(),
});
export type CompanyProductView = z.infer<typeof companyProductViewSchema>;

export const listCompanyProductsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
});
export type ListCompanyProductsQuery = z.infer<typeof listCompanyProductsQuerySchema>;

/* ------------------------------------------------------------------ *
 * Products by CSV
 * ------------------------------------------------------------------ */

/** The most rows one file may hold. */
export const COMPANY_CSV_MAX_ROWS = 500;

/**
 * The columns a company's file has, in any order: the DRAP importer's. A
 * `company` column may be there and is ignored, since the company is whoever
 * sends it.
 */
export const COMPANY_CSV_COLUMNS = ['registrationNo', 'brand', 'composition', 'strength', 'form', 'pack'] as const;

/**
 * `POST /company/products/csv/check` and `POST /company/products/csv`: the
 * file's text, in the JSON body. 500 rows of the importer's columns are well
 * under the API's JSON limit, so the route needs no limit of its own.
 */
export const companyCsvBodySchema = z.object({
  csv: z.string().min(1).max(1_000_000),
});
export type CompanyCsvBody = z.infer<typeof companyCsvBodySchema>;

/**
 * What a row would become: a new product, a change to one of this company's
 * own, a claim on a DRAP-imported product, or nothing because it already says
 * this. Null when the row has problems.
 */
export const csvRowOutcomeSchema = z.enum(['new', 'update', 'claim', 'unchanged']);
export type CsvRowOutcome = z.infer<typeof csvRowOutcomeSchema>;

export const csvRowCheckSchema = z.object({
  /** The file's line, the header being line 1. A quoted line break would put this out, so it is a hint. */
  line: z.number().int(),
  registrationNo: z.string(),
  brand: z.string(),
  outcome: csvRowOutcomeSchema.nullable(),
  problems: z.array(z.string()),
});
export type CsvRowCheck = z.infer<typeof csvRowCheckSchema>;

export const csvCheckViewSchema = z.object({
  rows: z.array(csvRowCheckSchema),
  counts: z.object({
    new: z.number().int(),
    update: z.number().int(),
    claim: z.number().int(),
    unchanged: z.number().int(),
    problems: z.number().int(),
  }),
});
export type CsvCheckView = z.infer<typeof csvCheckViewSchema>;

/**
 * What `POST /company/products/csv` sent: one submission per row, grouped by
 * `uploadId` so a reviewer sees them together. A file with any problem sends
 * nothing; check it first.
 */
export const csvSendViewSchema = z.object({
  uploadId: z.string(),
  submissionIds: z.array(objectIdSchema),
  counts: csvCheckViewSchema.shape.counts,
});
export type CsvSendView = z.infer<typeof csvSendViewSchema>;
