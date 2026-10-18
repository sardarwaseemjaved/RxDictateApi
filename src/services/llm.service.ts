import config from '../config/config';
import { AppError } from '../core/errors';
import {
  SECTIONS,
  medicineFlagSchema,
  medicineFormSchema,
  medicineRouteSchema,
  medicineTimingSchema,
  opSchema,
  type Op,
  type PrescriptionSections,
} from '../shared/prescription.schema';
import type { Span } from '../shared/voice.schema';
import { callOpenAi, tokenCostUsd } from './openai.client';

/** What the extractor says about one span, once it has read the whole transcript. */
export interface SpanAnnotation {
  id: string;
  english: string;
  isDictation: boolean;
}

export interface Extraction {
  ops: Op[];
  spans: SpanAnnotation[];
  model: string;
  costUsd: number | null;
}

export interface ExtractionInput {
  transcript: string;
  spans: Span[];
  /** What is already on the draft, so an update can address an existing line. */
  sections: PrescriptionSections;
}

/* ------------------------------------------------------------------ *
 * The shape the model must answer in
 * ------------------------------------------------------------------ */

const nullable = (type: string) => ({ type: [type, 'null'] });

/**
 * One flat object for every section's fields rather than a union.
 *
 * Structured outputs will not take a union at the root and is awkward with
 * nested ones, and the server has to narrow the value per section anyway -
 * validateOps applies the section's own schema and strips anything that
 * section does not accept. So the model fills in what it heard, the fields it
 * did not hear stay null, and the server decides what any of it means.
 *
 * The dose is three flat numbers instead of a nested object for the same
 * reason: one less nullable object for the model to get wrong.
 */
const valueSchema = {
  type: 'object',
  properties: {
    text: nullable('string'),
    code: nullable('string'),
    name: nullable('string'),
    strength: nullable('string'),
    form: { type: ['string', 'null'], enum: [...medicineFormSchema.options, null] },
    route: { type: ['string', 'null'], enum: [...medicineRouteSchema.options, null] },
    timing: { type: ['string', 'null'], enum: [...medicineTimingSchema.options, null] },
    doseMorning: nullable('number'),
    doseAfternoon: nullable('number'),
    doseNight: nullable('number'),
    asNeeded: nullable('boolean'),
    durationDays: nullable('number'),
    instructionEn: nullable('string'),
    instructionUr: nullable('string'),
    flags: { type: 'array', items: { type: 'string', enum: medicineFlagSchema.options } },
    inDays: nullable('number'),
    date: nullable('string'),
    note: nullable('string'),
  },
  required: [
    'text',
    'code',
    'name',
    'strength',
    'form',
    'route',
    'timing',
    'doseMorning',
    'doseAfternoon',
    'doseNight',
    'asNeeded',
    'durationDays',
    'instructionEn',
    'instructionUr',
    'flags',
    'inDays',
    'date',
    'note',
  ],
  additionalProperties: false,
} as const;

/**
 * Built from the shared constants, so renaming a section or adding a timing
 * changes what the model is allowed to say without anybody remembering to edit
 * a prompt.
 */
const responseSchema = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'remove'] },
          section: { type: 'string', enum: [...SECTIONS] },
          itemId: nullable('string'),
          spanIds: { type: 'array', items: { type: 'string' } },
          value: valueSchema,
        },
        required: ['op', 'section', 'itemId', 'spanIds', 'value'],
        additionalProperties: false,
      },
    },
    spans: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          english: { type: 'string' },
          isDictation: { type: 'boolean' },
        },
        required: ['id', 'english', 'isDictation'],
        additionalProperties: false,
      },
    },
  },
  required: ['ops', 'spans'],
  additionalProperties: false,
} as const;

/* ------------------------------------------------------------------ *
 * The prompt
 * ------------------------------------------------------------------ */

const SYSTEM_PROMPT = [
  "You convert a Pakistani doctor's dictation into edits to a prescription draft.",
  '',
  'Use only what was said. Never invent a drug, a dose, a duration or a diagnosis.',
  '',
  'A medicine needs a name. If the dose was not said, leave doseMorning, doseAfternoon,',
  'doseNight and asNeeded null and put "dose_unclear" in flags. If the duration was not',
  'said, leave durationDays null and add "duration_unclear". If you could not make out',
  'which drug was meant, add "drug_unknown". Never fill a field in to make a line look',
  'complete: a flagged line is reviewed by the doctor, a guessed one is not.',
  '',
  'Dose words map to the three numbers: "subah shaam" and "morning evening" are 1, 0, 1.',
  '"raat ko" and "at night" are 0, 0, 1. "subah" is 1, 0, 0. "din mein teen baar" and',
  '"three times a day" are 1, 1, 1. "zaroorat ke waqt" and "SOS" set asNeeded true.',
  'Timing words map to timing: "khane ke baad" is after_meal, "khane se pehle" is',
  'before_meal, "khane ke sath" is with_meal, "nihar munh" is empty_stomach.',
  '',
  'To change a line that is already on the draft, use op "update" with its exact itemId',
  'from the draft below. Only add a line when it is not there. Use "remove" when the',
  'doctor says to take something off.',
  '',
  'Speech to the patient is not dictation. "Aap theek ho jayenge", "don\'t worry",',
  'greetings and small talk produce no ops at all.',
  '',
  'Put the ids of the spans a line came from in spanIds, so the doctor can see what was',
  'said. Set isDictation false on any span that was speech to the patient, and give an',
  'English rendering of every span in english - the same text when it was already',
  'English.',
].join('\n');

/** The draft as the model needs to see it: sections, with the ids it must address. */
const describeSections = (sections: PrescriptionSections): string => {
  const lines: string[] = [];

  (['complaints', 'history', 'examination', 'labs', 'dietEat', 'dietAvoid', 'advice'] as const).forEach((section) => {
    sections[section].forEach((item) => lines.push(`${section} [${item.id}] ${item.text}`));
  });
  sections.diagnosis.forEach((item) => lines.push(`diagnosis [${item.id}] ${item.text}`));
  sections.medicines.forEach((medicine) => {
    const dose = 'sos' in medicine.pattern ? 'SOS' : `${medicine.pattern.m}-${medicine.pattern.a}-${medicine.pattern.n}`;
    lines.push(
      `medicines [${medicine.id}] ${medicine.name} ${medicine.strength} ${medicine.form} ${dose} ${medicine.timing} ${medicine.durationDays}d`,
    );
  });

  const { followUp } = sections;
  if (followUp.date || followUp.inDays !== null || followUp.note) {
    lines.push(`followUp date=${followUp.date ?? '-'} inDays=${followUp.inDays ?? '-'} note=${followUp.note}`);
  }

  return lines.length > 0 ? lines.join('\n') : '(the draft is empty)';
};

/* ------------------------------------------------------------------ *
 * The answer, turned into ops
 * ------------------------------------------------------------------ */

interface WireValue {
  [key: string]: unknown;
  doseMorning?: number | null;
  doseAfternoon?: number | null;
  doseNight?: number | null;
  asNeeded?: boolean | null;
  flags?: string[];
}

interface WireOp {
  op: string;
  section: string;
  itemId: string | null;
  spanIds: string[];
  value: WireValue;
}

/**
 * Drop everything the model did not hear and fold the three dose numbers back
 * into the pattern the contract uses.
 *
 * Anything left that the section does not accept is stripped by validateOps,
 * and anything missing that it needs fails there. This only has to stop nulls
 * being read as "set this to nothing".
 */
const toOpValue = (wire: WireValue): Record<string, unknown> => {
  const value: Record<string, unknown> = {};

  Object.entries(wire).forEach(([key, item]) => {
    if (item === null || item === undefined) return;
    if (['doseMorning', 'doseAfternoon', 'doseNight', 'asNeeded'].includes(key)) return;
    if (key === 'flags' && Array.isArray(item) && item.length === 0) return;
    value[key] = item;
  });

  if (wire.asNeeded === true) {
    value.pattern = { sos: true };
  } else if (
    typeof wire.doseMorning === 'number' ||
    typeof wire.doseAfternoon === 'number' ||
    typeof wire.doseNight === 'number'
  ) {
    value.pattern = {
      m: wire.doseMorning ?? 0,
      a: wire.doseAfternoon ?? 0,
      n: wire.doseNight ?? 0,
    };
  }
  // No dose at all leaves pattern unset, and the flag the model was told to
  // add is what stops it being approved on the schema's default.

  return value;
};

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Turn a transcript into operations.
 *
 * This is the half of the voice feature the server does not trust. Whatever
 * comes back is a proposal: it is shape-checked here and then checked again,
 * properly, by prescriptionOps.validateOps before a single section is touched.
 * An extractor that invents a field, a section or an item id gets an
 * OP_INVALID and the segment is marked failed. That is rule 6, and it is why
 * this file can be replaced without anybody auditing the prescription code.
 */
export const extractOps = async (input: ExtractionInput): Promise<Extraction> => {
  if (config.voice.llmProvider === 'none') {
    throw new AppError('TRANSCRIPTION_FAILED', 'No ops extractor is configured on this server.');
  }

  if (config.voice.llmProvider === 'openai') {
    const answer = await callOpenAi<ChatCompletion>({
      path: '/chat/completions',
      json: true,
      // The rest of the segment's budget; the transcription has had its share.
      timeoutMs: Math.round(config.voice.segmentTimeoutMs * 0.35),
      body: JSON.stringify({
        model: config.openai.model,
        // Nothing here is a matter of taste, so no room for invention.
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'prescription_ops', strict: true, schema: responseSchema },
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              'Draft so far:',
              describeSections(input.sections),
              '',
              'Spans of what was just said:',
              ...input.spans.map((span) => `[${span.id}] (${span.lang}) ${span.original}`),
            ].join('\n'),
          },
        ],
      }),
    });

    const content = answer.choices?.[0]?.message?.content;
    if (!content) {
      throw new AppError('TRANSCRIPTION_FAILED', 'The dictation service returned an empty answer. Please retry.');
    }

    let parsed: { ops?: WireOp[]; spans?: SpanAnnotation[] };
    try {
      parsed = JSON.parse(content) as { ops?: WireOp[]; spans?: SpanAnnotation[] };
    } catch {
      throw new AppError('TRANSCRIPTION_FAILED', 'The dictation service returned something that is not valid JSON.');
    }

    const candidates = (parsed.ops ?? []).map((wire) => ({
      op: wire.op,
      section: wire.section,
      itemId: wire.itemId,
      value: toOpValue(wire.value ?? {}),
      spanIds: wire.spanIds ?? [],
    }));

    // Shape only. Whether the section accepts this value, and whether the item
    // id exists, is the server's call and not the extractor's.
    const result = opSchema.array().safeParse(candidates);
    if (!result.success) {
      throw new AppError('OP_INVALID', 'The extractor returned ops that are not the right shape.', result.error.issues);
    }

    return {
      ops: result.data,
      spans: parsed.spans ?? [],
      model: config.openai.model,
      costUsd: tokenCostUsd(config.openai.model, answer.usage?.prompt_tokens ?? 0, answer.usage?.completion_tokens ?? 0),
    };
  }

  /**
   * The deterministic driver. A JSON array of ops in the transcript is handed
   * straight through, which is how the validation path is tested - including
   * with ops that are deliberately wrong - and anything else becomes one
   * complaint per dictated span.
   */
  const trimmed = input.transcript.trim();

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new AppError('TRANSCRIPTION_FAILED', 'The extractor returned something that is not valid JSON.');
    }
    const result = opSchema.array().safeParse(parsed);
    if (!result.success) {
      throw new AppError('OP_INVALID', 'The extractor returned ops that are not the right shape.', result.error.issues);
    }
    return { ops: result.data, spans: [], model: 'mock-llm', costUsd: 0 };
  }

  return {
    ops: input.spans
      .filter((span) => span.isDictation)
      .map((span) => ({
        op: 'add' as const,
        section: 'complaints' as const,
        itemId: null,
        value: { text: span.english },
        spanIds: [span.id],
      })),
    spans: [],
    model: 'mock-llm',
    costUsd: 0,
  };
};

export default { extractOps };
