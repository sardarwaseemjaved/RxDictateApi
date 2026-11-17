import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema } from './common';
import { organisationStatusSchema, organisationTypeSchema } from './roles';
import { drugViewSchema } from './drug.schema';
import { medicineFormSchema } from './prescription.schema';
import { claimProductBodySchema, productFieldsSchema, updateProductBodySchema } from './company.schema';
import {
  announcementAllowanceViewSchema,
  announcementProductRefSchema,
  companyAnnouncementPayloadSchema,
  signedImageSchema,
} from './announcement.schema';
import { submissionStatusSchema, submissionTypeSchema, type SubmissionType } from './submissionStatus';

export { submissionStatusSchema, submissionTypeSchema, submissionSummarySchema } from './submissionStatus';
export type { SubmissionStatus, SubmissionType, SubmissionSummary } from './submissionStatus';

/* ------------------------------------------------------------------ *
 * Payloads, by type
 * ------------------------------------------------------------------ */

/** A clinic's item as it stood when it was proposed. Taken by the server from the row, never typed. */
export const proposalPayloadSchema = z.object({
  brand: z.string(),
  generic: z.string(),
  strength: z.string(),
  form: medicineFormSchema,
  pack: z.string(),
  company: z.string(),
});
export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;

/**
 * What each type's `payload` holds. The view sends it as a plain object; an
 * app that needs its fields parses it with the schema for its `type`.
 *
 * - `drug.create`: the product, in the importer's columns.
 * - `drug.update`: only the fields that change.
 * - `drug.discontinue`: nothing; the product is `drugId`.
 * - `drug.claim`: the registration number. `drugId` is the row it names.
 * - `drug.propose`: the clinic's item as it was sent. `drugId` is that item.
 * - `announcement.create`: the company's announcement and its wishes. The
 *   submission's `drugId` stays null; a product is `payload.drugId`.
 */
export const SUBMISSION_PAYLOAD_SCHEMAS = {
  'drug.create': productFieldsSchema,
  'drug.update': updateProductBodySchema,
  'drug.discontinue': z.object({}),
  'drug.claim': claimProductBodySchema,
  'drug.propose': proposalPayloadSchema,
  'announcement.create': companyAnnouncementPayloadSchema,
} satisfies Record<SubmissionType, z.ZodType>;

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

export const submissionStepSchema = z.enum([
  'submitted',
  'resubmitted',
  'approved',
  'rejected',
  'changesRequested',
  'withdrawn',
]);
export type SubmissionStep = z.infer<typeof submissionStepSchema>;

/** One step in a submission's life. A sender sees `by` only for their own organisation's steps. */
export const submissionHistoryEntrySchema = z.object({
  step: submissionStepSchema,
  at: z.coerce.date(),
  by: objectIdSchema.nullable(),
  note: z.string().nullable(),
});
export type SubmissionHistoryEntry = z.infer<typeof submissionHistoryEntrySchema>;

export const submissionViewSchema = z.object({
  id: objectIdSchema,
  type: submissionTypeSchema,
  status: submissionStatusSchema,
  payload: z.record(z.string(), z.unknown()),
  /**
   * What the submission is about, in a few words, for a list row. A new
   * product is named by its payload; anything else by the row `drugId` names,
   * as that row is now. Null only when there is nothing to name it by, and
   * always for an announcement, which the apps name by `payload.title`.
   */
  subject: z.object({ brand: z.string(), strength: z.string().nullable() }).nullable(),
  /** Who sent it. */
  organisation: z.object({
    id: objectIdSchema,
    name: z.string(),
    type: organisationTypeSchema,
    status: organisationStatusSchema,
  }),
  submittedBy: objectIdSchema,
  /** What it is about: the product, the DRAP row claimed, or the clinic's item. Null for a new product. */
  drugId: objectIdSchema.nullable(),
  /** Rows of one CSV upload share this. */
  uploadId: z.string().nullable(),
  /** The reviewer's latest note: why it was rejected, or what to change. */
  note: z.string().nullable(),
  /** Null for a sender: who reviewed is the platform's business. */
  reviewerId: objectIdSchema.nullable(),
  /** On a rejected `drug.create`: the national row it duplicates, which the company may claim instead. */
  duplicateOfId: objectIdSchema.nullable(),
  /** Once approved: the national row it made or changed, or, for a merged proposal, the row it went into. */
  resultDrugId: objectIdSchema.nullable(),
  /** Once an `announcement.create` is approved: the draft it made in RxDictate's console. */
  resultAnnouncementId: objectIdSchema.nullable(),
  history: z.array(submissionHistoryEntrySchema),
  /** When it was last sent, which is what the queue is ordered by. */
  submittedAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type SubmissionView = z.infer<typeof submissionViewSchema>;

/**
 * What an `announcement.create` names, as it can be shown before approving
 * makes a draft: the medicine `payload.drugId` names, as that row is now and
 * whether or not it is still active (null when there is none, or the row is
 * gone), and a signed link to `payload.imageKey` (null when there is none).
 */
export const submissionAnnouncementSchema = z.object({
  product: announcementProductRefSchema.nullable(),
  image: signedImageSchema.nullable(),
});
export type SubmissionAnnouncement = z.infer<typeof submissionAnnouncementSchema>;

/**
 * `GET /submissions/:id`.
 *
 * - `current`: the live row as it is now, for an update, discontinuation,
 *   claim or proposal, so the payload can be compared with it.
 * - `duplicates`: for a reviewer, national rows that may be the same product -
 *   the same registration number, or the same brand, strength and form among
 *   active ones. Always empty for a sender.
 * - `allowance`: for an `announcement.create` only, the sending company's
 *   announcement allowance and this month's use, for the reviewer and the
 *   sender alike. Null for every other type.
 * - `announcement`: for an `announcement.create` only, its medicine and image
 *   (submissionAnnouncementSchema), for the reviewer and the sender alike.
 *   Null for every other type.
 */
export const submissionDetailViewSchema = z.object({
  submission: submissionViewSchema,
  current: drugViewSchema.nullable(),
  duplicates: z.array(drugViewSchema),
  allowance: announcementAllowanceViewSchema.nullable(),
  announcement: submissionAnnouncementSchema.nullable(),
});
export type SubmissionDetailView = z.infer<typeof submissionDetailViewSchema>;

/* ------------------------------------------------------------------ *
 * Requests
 * ------------------------------------------------------------------ */

/**
 * `GET /submissions`. A reviewer sees every organisation's and may filter by
 * one; a company or a clinic sees only its own, and `organisationId` is
 * ignored. With no `status`, open ones come first: pending, then changes
 * requested, then the rest. Within each, the oldest sent first.
 */
export const listSubmissionsQuerySchema = paginationQuerySchema.extend({
  status: submissionStatusSchema.optional(),
  type: submissionTypeSchema.optional(),
  organisationId: objectIdSchema.optional(),
  uploadId: z.string().trim().max(64).optional(),
});
export type ListSubmissionsQuery = z.infer<typeof listSubmissionsQuerySchema>;

/**
 * `POST /submissions/:id/approve`. A `drug.propose` needs `decision`:
 * `publish` makes the clinic's row national with the same id; `merge` moves
 * its list items and usage into `intoDrugId`, an active national row, and
 * retires it. Other types take neither. An `announcement.create` becomes a
 * draft with the company as sponsor, which is published from the console.
 */
export const approveSubmissionBodySchema = z
  .object({
    decision: z.enum(['publish', 'merge']).optional(),
    intoDrugId: objectIdSchema.optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.decision === 'merge' && !body.intoDrugId) {
      ctx.addIssue({ code: 'custom', path: ['intoDrugId'], message: 'is needed to merge' });
    }
    if (body.decision !== 'merge' && body.intoDrugId) {
      ctx.addIssue({ code: 'custom', path: ['intoDrugId'], message: 'is only for a merge' });
    }
  });
export type ApproveSubmissionBody = z.infer<typeof approveSubmissionBodySchema>;

/**
 * `POST /submissions/:id/reject`. The note is what the sender reads. On a new
 * product that is already in the catalog, `duplicateOfId` names that row, so
 * the company can claim it instead.
 */
export const rejectSubmissionBodySchema = z.object({
  note: z.string().trim().min(1).max(1000),
  duplicateOfId: objectIdSchema.optional(),
});
export type RejectSubmissionBody = z.infer<typeof rejectSubmissionBodySchema>;

/** `POST /submissions/:id/request-changes`: what to change, which the sender reads. */
export const requestChangesBodySchema = z.object({
  note: z.string().trim().min(1).max(1000),
});
export type RequestChangesBody = z.infer<typeof requestChangesBodySchema>;

/**
 * `PATCH /submissions/:id`: send a `changesRequested` one again, as the same
 * submission with its history kept. `payload` replaces the one before and is
 * checked against its type's schema. A proposal takes no payload: it is sent
 * as the clinic's item now stands, so correct the item first.
 */
export const resubmitSubmissionBodySchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type ResubmitSubmissionBody = z.infer<typeof resubmitSubmissionBodySchema>;
