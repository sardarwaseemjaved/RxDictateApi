import { Drug, drugKeys, Practice, type IDrug } from '../models';
import { writeAudit } from '../core/audit';
import type { Scope } from '../core/db';
import type { MedicineItem } from '../shared/prescription.schema';
import { parseCsv } from '../utils/csv';

/** The columns a file must have, in any order. */
export const IMPORT_COLUMNS = ['registrationNo', 'brand', 'composition', 'strength', 'form', 'pack', 'company'] as const;
type Column = (typeof IMPORT_COLUMNS)[number];

/**
 * What a word in the file's form column means, tried in this order, so
 * "Suspension for Injection" is an injection and "Eye Drops" is drops.
 */
const FORM_WORDS: [MedicineItem['form'], string[]][] = [
  ['inj', ['inj', 'injection', 'injections', 'injectable', 'infusion', 'vial', 'ampoule']],
  ['drops', ['drop', 'drops']],
  ['spray', ['spray', 'sprays', 'inhaler']],
  ['cream', ['cream', 'creams']],
  ['ointment', ['ointment', 'ointments', 'oint']],
  ['sachet', ['sachet', 'sachets']],
  ['cap', ['cap', 'caps', 'capsule', 'capsules']],
  ['tab', ['tab', 'tabs', 'tablet', 'tablets']],
  ['syp', ['syp', 'syrup', 'syrups', 'suspension', 'elixir', 'linctus']],
];

/** The file's form, as one of ours. Anything unknown is `other`. */
export const formFromFile = (text: string): MedicineItem['form'] => {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/));
  return FORM_WORDS.find(([, known]) => known.some((word) => words.has(word)))?.[0] ?? 'other';
};

export interface ImportOptions {
  /** Say what would happen, and change nothing. */
  dryRun?: boolean;
  /** Mark national rows that are not in the file as discontinued. Without it, nothing is ever removed. */
  discontinueMissing?: boolean;
}

export interface ImportSummary {
  dryRun: boolean;
  inserted: number;
  updated: number;
  discontinued: number;
  skipped: { line: number; registrationNo: string; reason: string }[];
}

/** One bulk write at a time, so a big file cannot build one enormous command. */
const BATCH = 1000;

/**
 * A script has no request and no clinic to write to, so its audit entry goes on
 * the platform organisation, in the name of whoever owns it. Before
 * `yarn platform:init` there is nowhere to write one.
 */
export const auditOnPlatform = async (action: string, after: unknown): Promise<boolean> => {
  const platform = await Practice.findOne({ type: 'platform' });
  if (!platform) {
    return false;
  }
  const scope: Scope = {
    practiceId: platform._id,
    actorId: platform.ownerId,
    role: 'platformAdmin',
    allowedLocationIds: [],
  };
  await writeAudit(scope, { action, entity: 'drug', after: { ...(after as object), by: 'script' } });
  return true;
};

/**
 * The national catalog, from a DRAP file. Keyed by registration number, so it
 * is safe to run twice: a new one is inserted and a known one updated, which
 * also brings back one that had been discontinued.
 *
 * A row skipped for a missing brand still names its registration number, so
 * `discontinueMissing` does not retire a product over a bad line. A file with
 * nothing usable in it is refused rather than read as "every product is gone".
 */
export const importDrugs = async (csv: string, options: ImportOptions = {}): Promise<ImportSummary> => {
  const { dryRun = false, discontinueMissing = false } = options;

  const [header, ...rows] = parseCsv(csv);
  const columns = (header ?? []).map((name) => name.trim().toLowerCase());
  const missing = IMPORT_COLUMNS.filter((column) => !columns.includes(column.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`The file is missing these columns: ${missing.join(', ')}`);
  }
  const read = (row: string[], column: Column): string => (row[columns.indexOf(column.toLowerCase())] ?? '').trim();

  const summary: ImportSummary = { dryRun, inserted: 0, updated: 0, discontinued: 0, skipped: [] };
  const named = new Set<string>();
  const usable: { registrationNo: string; row: string[] }[] = [];

  rows.forEach((row, index) => {
    // The header is line 1. A quoted line break would put this out, which is why a row's number is only a hint.
    const line = index + 2;
    const registrationNo = read(row, 'registrationNo');
    if (!registrationNo) {
      summary.skipped.push({ line, registrationNo, reason: 'no registration number' });
      return;
    }
    if (named.has(registrationNo)) {
      summary.skipped.push({ line, registrationNo, reason: 'this registration number is already in the file' });
      return;
    }
    named.add(registrationNo);
    if (!read(row, 'brand')) {
      summary.skipped.push({ line, registrationNo, reason: 'no brand' });
      return;
    }
    usable.push({ registrationNo, row });
  });

  if (usable.length === 0) {
    throw new Error('Nothing in the file can be imported, so nothing was changed.');
  }

  const known = new Map(
    (await Drug.find({ scope: 'national', drapRegNo: { $in: [...named] } }).select('drapRegNo aliases')).map((drug) => [
      drug.drapRegNo!,
      drug.aliases,
    ]),
  );
  summary.inserted = usable.filter(({ registrationNo }) => !known.has(registrationNo)).length;
  summary.updated = usable.length - summary.inserted;

  const stillAround = {
    scope: 'national',
    status: 'active',
    drapRegNo: { $nin: [...named] },
  };

  if (dryRun) {
    summary.discontinued = discontinueMissing ? await Drug.countDocuments(stillAround) : 0;
    return summary;
  }

  const writes = usable.map(({ registrationNo, row }) => {
    const fields: Pick<IDrug, 'brand' | 'generic' | 'strength' | 'form' | 'pack' | 'company'> = {
      brand: read(row, 'brand'),
      generic: read(row, 'composition'),
      strength: read(row, 'strength'),
      form: formFromFile(read(row, 'form')),
      pack: read(row, 'pack'),
      company: read(row, 'company'),
    };
    return {
      updateOne: {
        filter: { drapRegNo: registrationNo },
        update: {
          $set: {
            ...fields,
            ...drugKeys({ ...fields, aliases: known.get(registrationNo) ?? [] }),
            source: 'drapImport' as const,
            status: 'active' as const,
          },
          $setOnInsert: { scope: 'national' as const, practiceId: null, ownerId: null, aliases: [], createdBy: null },
        },
        upsert: true,
      },
    };
  });

  await Array.from({ length: Math.ceil(writes.length / BATCH) }, (_, at) =>
    writes.slice(at * BATCH, (at + 1) * BATCH),
  ).reduce<Promise<unknown>>(async (previous, batch) => {
    await previous;
    await Drug.bulkWrite(batch, { ordered: false });
  }, Promise.resolve());

  if (discontinueMissing) {
    summary.discontinued = (await Drug.updateMany(stillAround, { $set: { status: 'discontinued' } })).modifiedCount;
  }

  await auditOnPlatform('drug.import', {
    inserted: summary.inserted,
    updated: summary.updated,
    discontinued: summary.discontinued,
    skipped: summary.skipped.length,
  });

  return summary;
};

export default { importDrugs, formFromFile, auditOnPlatform };
