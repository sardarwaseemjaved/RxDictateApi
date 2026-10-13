import config from '../config/config';
import { AppError } from '../core/errors';
import { opSchema, type Op, type PrescriptionSections } from '../shared/prescription.schema';
import type { Span } from '../shared/voice.schema';

export interface Extraction {
  ops: Op[];
  model: string;
  costUsd: number | null;
}

export interface ExtractionInput {
  transcript: string;
  spans: Span[];
  /** What is already on the draft, so an update can address an existing line. */
  sections: PrescriptionSections;
}

/**
 * Turn a transcript into operations.
 *
 * This is the half of the voice feature that the server does not trust. Whatever
 * comes back from here is a proposal: it is shape-checked below and then checked
 * again, properly, by prescriptionOps.validateOps before a single section is
 * touched. An extractor that invents a field, a section or an item id gets an
 * OP_INVALID and the segment is marked failed. That is rule 6, and it is why
 * this file can be replaced without anybody auditing the prescription code.
 *
 * Like the transcriber, the provider itself is a seam. 'none' is the default.
 * 'mock' accepts a JSON array of ops in the transcript - which is how the
 * validation path is tested, including with ops that are deliberately wrong -
 * and otherwise files each dictated span as a complaint.
 */
export const extractOps = async (input: ExtractionInput): Promise<Extraction> => {
  if (config.voice.llmProvider === 'none') {
    throw new AppError('TRANSCRIPTION_FAILED', 'No ops extractor is configured on this server.');
  }

  const trimmed = input.transcript.trim();

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new AppError('TRANSCRIPTION_FAILED', 'The extractor returned something that is not valid JSON.');
    }
    // Shape only. Whether the section accepts this value, and whether the item
    // id exists, is the server's call and not the extractor's.
    const result = opSchema.array().safeParse(parsed);
    if (!result.success) {
      throw new AppError('OP_INVALID', 'The extractor returned ops that are not the right shape.', result.error.issues);
    }
    return { ops: result.data, model: 'mock-llm', costUsd: 0 };
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
    model: 'mock-llm',
    costUsd: 0,
  };
};

export default { extractOps };
