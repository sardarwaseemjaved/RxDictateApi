import { z } from 'zod';
import { objectIdSchema } from './common';

/**
 * What the review queue holds, by type. Each type has one handler on the
 * server that knows its payload and what approving it does, so announcements
 * later are new types and handlers, not a new queue.
 *
 * - `drug.create`: a company's new product.
 * - `drug.update`: a change to a product the company owns.
 * - `drug.discontinue`: a company's product, to be marked discontinued.
 * - `drug.claim`: a company claims a DRAP-imported product by its registration number.
 * - `drug.propose`: a clinic's own item, offered to the national catalog.
 * - `announcement.create`: a company's announcement, with the dates and
 *   audience it would like. Approving makes a draft in RxDictate's console,
 *   which RxDictate then publishes; it never goes live from the queue.
 */
export const submissionTypeSchema = z.enum([
  'drug.create',
  'drug.update',
  'drug.discontinue',
  'drug.claim',
  'drug.propose',
  'announcement.create',
]);
export type SubmissionType = z.infer<typeof submissionTypeSchema>;

/**
 * - `pending`: waiting for a reviewer.
 * - `approved`: done; what it asked for is live, or for an announcement, a
 *   draft RxDictate publishes.
 * - `rejected`: refused, with a note. Final.
 * - `changesRequested`: the sender may edit it and send it again, as the same
 *   submission with its history kept.
 * - `withdrawn`: the sender took it back while it was pending. Final.
 */
export const submissionStatusSchema = z.enum(['pending', 'approved', 'rejected', 'changesRequested', 'withdrawn']);
export type SubmissionStatus = z.infer<typeof submissionStatusSchema>;

/** The latest submission about a product or a clinic's item, as shown beside it. */
export const submissionSummarySchema = z.object({
  id: objectIdSchema,
  type: submissionTypeSchema,
  status: submissionStatusSchema,
  /** The reviewer's note on a rejection or a request for changes. */
  note: z.string().nullable(),
  updatedAt: z.coerce.date(),
});
export type SubmissionSummary = z.infer<typeof submissionSummarySchema>;
