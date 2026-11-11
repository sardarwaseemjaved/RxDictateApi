import { randomBytes } from 'crypto';
import type { z } from 'zod';
import { Drug, Submission, type DrugDoc } from '../models';
import { AppError } from '../core/errors';
import type { Scope } from '../core/db';
import type { PageMeta } from '../shared/response';
import {
  COMPANY_CSV_COLUMNS,
  COMPANY_CSV_MAX_ROWS,
  productFieldsSchema,
  type CompanyProductView,
  type CsvCheckView,
  type CsvRowCheck,
  type CsvSendView,
  type ListCompanyProductsQuery,
  type ProductFields,
} from '../shared/company.schema';
import type { MedicineItem } from '../shared/prescription.schema';
import { submissionTypeSchema } from '../shared/submissionStatus';
import { parseCsv } from '../utils/csv';
import { formFromFile } from './drugImport.service';
import { nationalRows, prefixOf } from './drugAccess.service';
import { latestSubmissionsFor } from './submissionLookup.service';
import { submitClaim, submitCreate, submitUpdate } from './submission.service';

type Audited = Scope & { requestId?: string | null };

/**
 * A company's products, as the company sees them: only its own, and never
 * usage or who prescribes them. Everything it sends goes to review through
 * submission.service; nothing here changes a row.
 */

const toProductView = (drug: DrugDoc, latest: CompanyProductView['latestSubmission']): CompanyProductView => ({
  id: String(drug._id),
  brand: drug.brand,
  composition: drug.generic,
  strength: drug.strength,
  form: drug.form,
  pack: drug.pack,
  registrationNo: drug.drapRegNo,
  status: drug.status,
  latestSubmission: latest,
});

/** `GET /company/products`: by name, each with its latest submission's status. */
export const listProducts = async (
  scope: Scope,
  query: ListCompanyProductsQuery,
): Promise<{ products: CompanyProductView[]; meta: PageMeta }> => {
  const prefix = query.q ? prefixOf(query.q) : null;
  const result = await Drug.paginate(
    {
      ...nationalRows,
      companyId: scope.practiceId,
      ...(prefix ? { $or: [{ nameKeys: prefix }, { wordKeys: prefix }, { drapRegNo: query.q }] } : {}),
    },
    { page: query.page, limit: query.limit, sortBy: 'brandKey:asc,strength:asc,_id:asc' },
  );
  const latest = await latestSubmissionsFor(
    scope.practiceId,
    result.results.map((drug) => drug._id),
    submissionTypeSchema.options.filter((type) => type !== 'drug.propose'),
  );
  return {
    products: result.results.map((drug) => toProductView(drug, latest.get(String(drug._id)) ?? null)),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

interface CheckedRow extends CsvRowCheck {
  fields: ProductFields | null;
  drugId: string | null;
}

type Column = (typeof COMPANY_CSV_COLUMNS)[number];

/** How a problem names each column, as the company's forms do. */
const COLUMN_NAMES: Record<keyof ProductFields, string> = {
  registrationNo: 'DRAP registration number',
  brand: 'brand name',
  composition: 'composition',
  strength: 'strength',
  form: 'form',
  pack: 'pack',
};

/** What to ask for when a column the row needs is blank. */
const MISSING: Record<keyof ProductFields, string> = {
  registrationNo: 'Enter its DRAP registration number',
  brand: 'Enter the brand name',
  composition: 'Enter the composition',
  strength: 'Enter the strength',
  form: 'Choose a form',
  pack: 'Enter the pack',
};

/** The forms as the apps show them, for the one sentence that lists them. */
const FORM_NAMES: Record<MedicineItem['form'], string> = {
  tab: 'Tablet',
  cap: 'Capsule',
  syp: 'Syrup',
  inj: 'Injection',
  drops: 'Drops',
  cream: 'Cream',
  ointment: 'Ointment',
  sachet: 'Sachet',
  spray: 'Spray',
  other: 'Other',
};

/**
 * One validation issue as a sentence the company can act on. The apps show
 * problems as they are, so none of the validation library's own wording.
 */
const problemOf = (issue: z.core.$ZodIssue): string => {
  const column = issue.path[0] as keyof ProductFields | undefined;
  const name = column && column in COLUMN_NAMES ? COLUMN_NAMES[column] : null;
  if (!column || !name) {
    return 'This row could not be read';
  }
  if (issue.code === 'too_small' || (issue.code === 'invalid_type' && issue.input === undefined)) {
    return MISSING[column];
  }
  if (issue.code === 'too_big') {
    return `The ${name} is too long (at most ${String(issue.maximum)} characters)`;
  }
  if (column === 'form') {
    return `The form isn't one of: ${Object.values(FORM_NAMES).join(', ')}`;
  }
  return `The ${name} isn't valid`;
};

/** The fields a row would change on the company's own product, or none. */
const differences = (drug: DrugDoc, fields: ProductFields) =>
  Object.fromEntries(
    (
      [
        ['brand', drug.brand, fields.brand],
        ['composition', drug.generic, fields.composition],
        ['strength', drug.strength, fields.strength],
        ['form', drug.form, fields.form],
        ['pack', drug.pack, fields.pack],
      ] as const
    )
      .filter(([, live, sent]) => live !== sent)
      .map(([field, , sent]) => [field, sent]),
  );

/**
 * Every row, checked against the catalog and this company's open submissions,
 * changing nothing. A row's registration number decides what it is: one of
 * this company's products is an update, a DRAP row nobody owns is a claim,
 * and one not in the catalog is new.
 */
const checkRows = async (scope: Scope, csv: string): Promise<CheckedRow[]> => {
  const [header, ...rows] = parseCsv(csv);
  const columns = (header ?? []).map((name) => name.trim().toLowerCase());
  const missing = COMPANY_CSV_COLUMNS.filter((column) => !columns.includes(column.toLowerCase()));
  if (missing.length > 0) {
    throw new AppError('VALIDATION_ERROR', `body.csv: the file is missing these columns: ${missing.join(', ')}`, [
      { field: 'body.csv', message: `is missing these columns: ${missing.join(', ')}` },
    ]);
  }
  if (rows.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'body.csv: the file has no rows', [
      { field: 'body.csv', message: 'has no rows' },
    ]);
  }
  if (rows.length > COMPANY_CSV_MAX_ROWS) {
    throw new AppError(
      'VALIDATION_ERROR',
      `body.csv: a file may have at most ${COMPANY_CSV_MAX_ROWS} rows; this one has ${rows.length}`,
      [{ field: 'body.csv', message: `has ${rows.length} rows; at most ${COMPANY_CSV_MAX_ROWS}` }],
    );
  }
  const read = (row: string[], column: Column): string => (row[columns.indexOf(column.toLowerCase())] ?? '').trim();

  const registrationNos = rows.map((row) => read(row, 'registrationNo')).filter(Boolean);
  const [known, open] = await Promise.all([
    Drug.find({ ...nationalRows, drapRegNo: { $in: registrationNos } }),
    Submission.find({
      practiceId: scope.practiceId,
      status: { $in: ['pending', 'changesRequested'] },
      type: { $in: ['drug.create', 'drug.update', 'drug.discontinue', 'drug.claim'] },
    }).select('type payload drugId'),
  ]);
  const byRegistration = new Map(known.map((drug) => [drug.drapRegNo!, drug]));
  const openRegistrations = new Set(
    open.flatMap((submission) =>
      typeof submission.payload?.registrationNo === 'string' ? [submission.payload.registrationNo] : [],
    ),
  );
  const openDrugs = new Set(open.flatMap((submission) => (submission.drugId ? [String(submission.drugId)] : [])));

  const seen = new Set<string>();
  return rows.map((row, index): CheckedRow => {
    const line = index + 2;
    const registrationNo = read(row, 'registrationNo');
    const brand = read(row, 'brand');
    const problems: string[] = [];

    const result = productFieldsSchema.safeParse({
      registrationNo,
      brand,
      composition: read(row, 'composition'),
      strength: read(row, 'strength'),
      form: formFromFile(read(row, 'form')),
      pack: read(row, 'pack'),
    });
    if (!result.success) {
      result.error.issues.forEach((issue) => problems.push(problemOf(issue)));
    }
    if (registrationNo && seen.has(registrationNo)) {
      problems.push('this registration number is already in the file');
    }
    seen.add(registrationNo);

    const fields = result.success ? result.data : null;
    const drug = registrationNo ? byRegistration.get(registrationNo) : undefined;
    let outcome: CheckedRow['outcome'] = null;

    if (drug?.companyId?.equals(scope.practiceId)) {
      if (openDrugs.has(String(drug._id))) {
        problems.push('a change to this product is already waiting for review');
      }
      outcome = fields && Object.keys(differences(drug, fields)).length === 0 ? 'unchanged' : 'update';
    } else if (drug?.companyId) {
      problems.push('this registration number belongs to another company');
    } else if (drug) {
      if (openDrugs.has(String(drug._id))) {
        problems.push('your claim on this product is already waiting for review');
      }
      outcome = 'claim';
    } else {
      if (registrationNo && openRegistrations.has(registrationNo)) {
        problems.push('a product with this registration number is already waiting for review');
      }
      outcome = 'new';
    }

    return {
      line,
      registrationNo,
      brand,
      outcome: problems.length > 0 ? null : outcome,
      problems,
      fields,
      drugId: drug ? String(drug._id) : null,
    };
  });
};

const countsOf = (rows: CsvRowCheck[]): CsvCheckView['counts'] => ({
  new: rows.filter((row) => row.outcome === 'new').length,
  update: rows.filter((row) => row.outcome === 'update').length,
  claim: rows.filter((row) => row.outcome === 'claim').length,
  unchanged: rows.filter((row) => row.outcome === 'unchanged').length,
  problems: rows.filter((row) => row.problems.length > 0).length,
});

const publicRow = ({ line, registrationNo, brand, outcome, problems }: CheckedRow): CsvRowCheck => ({
  line,
  registrationNo,
  brand,
  outcome,
  problems,
});

/** `POST /company/products/csv/check`: what each row would become, and what is wrong with any. Changes nothing. */
export const checkCsv = async (scope: Scope, csv: string): Promise<CsvCheckView> => {
  const rows = (await checkRows(scope, csv)).map(publicRow);
  return { rows, counts: countsOf(rows) };
};

/**
 * `POST /company/products/csv`: one submission per row, grouped by an upload
 * id. A file with any problem sends nothing - check it first - and a row that
 * already says what the product says sends nothing either.
 *
 * One row at a time, so each is checked against the ones sent before it.
 */
export const sendCsv = async (scope: Audited, csv: string): Promise<CsvSendView> => {
  const rows = await checkRows(scope, csv);
  const counts = countsOf(rows);
  if (counts.problems > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      `body.csv: ${counts.problems} of the rows have problems, so nothing was sent. Check the file first.`,
      rows
        .filter((row) => row.problems.length > 0)
        .map((row) => ({ field: `body.csv.line${row.line}`, message: row.problems.join('; ') })),
    );
  }

  const uploadId = randomBytes(12).toString('hex');
  const submissionIds = await rows.reduce<Promise<string[]>>(async (previous, row) => {
    const sent = await previous;
    const fields = row.fields!;
    if (row.outcome === 'new') {
      sent.push(String((await submitCreate(scope, fields, uploadId))._id));
    } else if (row.outcome === 'update') {
      const drug = (await Drug.findById(row.drugId))!;
      sent.push(String((await submitUpdate(scope, row.drugId!, differences(drug, fields), uploadId))._id));
    } else if (row.outcome === 'claim') {
      sent.push(String((await submitClaim(scope, { registrationNo: fields.registrationNo }, uploadId))._id));
    }
    return sent;
  }, Promise.resolve([]));

  return { uploadId, submissionIds, counts };
};

export default { listProducts, checkCsv, sendCsv };
