import type { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from '../core/errors';
import {
  LIST_SECTIONS,
  opValueSchemas,
  prescriptionSectionsSchema,
  type EditLogEntry,
  type ListSection,
  type Op,
  type PrescriptionSections,
  type Section,
} from '../shared/prescription.schema';
import { newItemId } from '../utils/ids';

/**
 * Who a batch came from. `template` is lines copied in from a saved template:
 * validated and applied like any other op, but neither a correction for the
 * edit log nor something said, so it marks nothing.
 */
export type OpOrigin = 'typed' | 'voice' | 'template';

export interface ApplyOpsResult {
  sections: PrescriptionSections;
  /** One entry per change a human made, which is what measures AI accuracy. */
  editLog: EditLogEntry[];
}

interface Normalized {
  op: Op;
  section: Section;
  /** The value after the section's own schema has had its say. */
  value: Record<string, unknown> | null;
  /** The item as it was, for the edit log. */
  before: unknown;
}

/**
 * The sections as src/shared describes them: plain JSON, with ObjectIds as
 * strings.
 *
 * A mongoose subtree holds real ObjectId instances and subdocuments, and the
 * contract knows nothing about either - it describes what goes over the wire.
 * Everything that validates, applies or prints sections comes through here
 * first, which also fills in any section a stored document predates.
 */
export const wireSections = (sections: unknown): PrescriptionSections =>
  prescriptionSectionsSchema.parse(JSON.parse(JSON.stringify(sections))) as PrescriptionSections;

const isListSection = (section: Section): section is ListSection => (LIST_SECTIONS as readonly string[]).includes(section);

const invalid = (index: number, op: Op, message: string, details?: unknown): AppError =>
  new AppError('OP_INVALID', `op ${index} (${op.op} ${op.section}): ${message}`, {
    index,
    op,
    ...(details ? { issues: details } : {}),
  });

const parsed = (index: number, op: Op, schema: z.ZodType): Record<string, unknown> => {
  const result = schema.safeParse(op.value);
  if (!result.success) {
    throw invalid(
      index,
      op,
      result.error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join(', '),
      result.error.issues,
    );
  }
  return result.data as Record<string, unknown>;
};

/** A whole new item: the section's defaults fill in whatever was not said. */
const parseNewValue = (index: number, op: Op, schema: z.ZodObject): Record<string, unknown> => {
  if (op.value === undefined || op.value === null) {
    throw invalid(index, op, 'a value is required');
  }
  return parsed(index, op, schema);
};

/**
 * A change to an item that already exists: only the fields that were sent.
 *
 * The item schemas carry defaults, and `.partial()` does not stop a default
 * firing for a key that was left out - so parsing `{ name: 'Rosuvastatin' }`
 * returns every other field filled with its default, and merging that over the
 * stored line silently resets the dose, the strength, the form and the
 * duration. On a prescription that means a medicine quietly moving from night
 * to morning because somebody confirmed the name.
 *
 * So the parsed value is narrowed back to the keys the caller actually sent.
 * Defaults become irrelevant rather than merely absent, which also covers
 * anything else zod might add, and an unknown key is dropped by the schema and
 * therefore never reaches the patch.
 */
const parseUpdateValue = (index: number, op: Op, schema: z.ZodObject): Record<string, unknown> => {
  if (op.value === undefined || op.value === null) {
    throw invalid(index, op, 'a value is required');
  }
  if (typeof op.value !== 'object' || Array.isArray(op.value)) {
    throw invalid(index, op, 'a value must be an object');
  }

  const sent = op.value as Record<string, unknown>;
  const result = parsed(index, op, schema.partial());

  const patch: Record<string, unknown> = {};
  Object.keys(sent).forEach((key) => {
    if (key in result) {
      patch[key] = result[key];
    }
  });

  if (Object.keys(patch).length === 0) {
    throw invalid(index, op, 'there is nothing in that value to change');
  }
  return patch;
};

/**
 * Check every op before any of them is applied.
 *
 * Two reasons it is a separate pass. A batch has to be all or nothing, or a bad
 * op halfway through leaves a prescription half edited. And this is the gate
 * that rule 6 rests on: voice produces ops and so does a typed edit, and
 * neither reaches a section without passing through here. An LLM that invents a
 * field, a section or an item id is refused with OP_INVALID rather than
 * trusted.
 */
export const validateOps = (current: PrescriptionSections, ops: Op[]): Normalized[] => {
  // A working copy of the ids, so a batch that adds an item and then updates it
  // validates, and one that removes an item twice does not.
  const knownIds = new Map<ListSection, Set<string>>();
  LIST_SECTIONS.forEach((section) => {
    knownIds.set(section, new Set(current[section].map((item) => item.id)));
  });

  return ops.map((op, index) => {
    const { section } = op;
    const schema = opValueSchemas[section] as unknown as z.ZodObject;

    if (!isListSection(section)) {
      // followUp is a single object, so there is nothing to add to or remove.
      if (op.op !== 'update') {
        throw invalid(index, op, `${section} can only be updated`);
      }
      return {
        op,
        section,
        value: parseUpdateValue(index, op, schema),
        before: current.followUp,
      };
    }

    const ids = knownIds.get(section)!;

    if (op.op === 'add') {
      if (op.itemId) {
        throw invalid(index, op, 'an itemId cannot be given when adding; the server mints one');
      }
      const value = parseNewValue(index, op, schema);
      return { op, section, value, before: null };
    }

    if (!op.itemId) {
      throw invalid(index, op, 'an itemId is required');
    }
    if (!ids.has(op.itemId)) {
      throw invalid(index, op, `there is no item ${op.itemId} in ${section}`);
    }

    if (op.op === 'remove') {
      ids.delete(op.itemId);
      return {
        op,
        section,
        value: null,
        before: current[section].find((item) => item.id === op.itemId) ?? null,
      };
    }

    return {
      op,
      section,
      value: parseUpdateValue(index, op, schema),
      before: current[section].find((item) => item.id === op.itemId) ?? null,
    };
  });
};

/**
 * Apply a validated batch and return the new sections.
 *
 * Pure: it takes the sections, not the document, so the caller decides when to
 * save and this can be unit tested without a database.
 *
 * `origin` is the only thing the callers differ on. A typed change is the
 * doctor correcting something and goes into the edit log; a dictated change
 * marks the line `correctedBySpeech` instead, so the two are told apart when
 * accuracy is measured later. A template's lines do neither.
 */
export const applyOps = (
  current: PrescriptionSections,
  ops: Op[],
  context: { actorId: Types.ObjectId; origin: OpOrigin; at?: Date },
): ApplyOpsResult => {
  // A copy to mutate, so a caller's sections are never changed underneath it.
  const sections = wireSections(current);
  const normalized = validateOps(sections, ops);
  const editLog: EditLogEntry[] = [];
  const at = context.at ?? new Date();
  const by = String(context.actorId);

  normalized.forEach(({ op, section, value, before }) => {
    if (section === 'followUp') {
      sections.followUp = { ...sections.followUp, ...(value as Partial<PrescriptionSections['followUp']>) };
      if (context.origin === 'typed') {
        editLog.push({ at, by, section, itemId: null, from: before, to: sections.followUp });
      }
      return;
    }

    const list = sections[section] as Record<string, unknown>[];

    if (op.op === 'add') {
      const spanIds = [...new Set([...(op.spanIds ?? []), ...((value?.sourceSpanIds as string[]) ?? [])])];
      const item = { ...value, id: newItemId(), sourceSpanIds: spanIds };
      list.push(item);
      if (context.origin === 'typed') {
        editLog.push({ at, by, section, itemId: item.id as string, from: null, to: item });
      }
      return;
    }

    const index = list.findIndex((item) => item.id === op.itemId);
    // validateOps has already proved the item is there.

    if (op.op === 'remove') {
      list.splice(index, 1);
      if (context.origin === 'typed') {
        editLog.push({ at, by, section, itemId: op.itemId!, from: before, to: null });
      }
      return;
    }

    const existing = list[index];
    const spanIds = [...new Set([...((existing.sourceSpanIds as string[]) ?? []), ...(op.spanIds ?? [])])];
    const updated: Record<string, unknown> = { ...existing, ...value, id: existing.id, sourceSpanIds: spanIds };

    if (section === 'medicines') {
      if (context.origin === 'voice') {
        // The doctor dictated a correction over this line.
        updated.correctedBySpeech = true;
      } else {
        // The doctor has looked at it and typed, so whatever the pipeline was
        // unsure about is settled.
        updated.flags = [];
      }
    }

    list[index] = updated;
    if (context.origin === 'typed') {
      editLog.push({ at, by, section, itemId: op.itemId!, from: before, to: updated });
    }
  });

  return { sections, editLog };
};

/** True when there is anything on the page worth printing. */
export const isEmpty = (sections: PrescriptionSections): boolean => {
  const anyList = LIST_SECTIONS.some((section) => sections[section].length > 0);
  const anyFollowUp = sections.followUp.inDays !== null || sections.followUp.date !== null || sections.followUp.note !== '';
  return !anyList && !anyFollowUp;
};

export default { validateOps, applyOps, isEmpty, wireSections };
