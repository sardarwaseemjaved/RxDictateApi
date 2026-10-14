import { z } from 'zod';
import { dateStringSchema, objectIdSchema } from './common';

export const reportTypeSchema = z.enum(['lab', 'imaging', 'old_prescription', 'other']);
export type ReportType = z.infer<typeof reportTypeSchema>;

/**
 * What the app may upload, as constants rather than prose, so the picker can
 * refuse a file before spending a minute sending it.
 */
export const REPORT_UPLOAD = {
  allowedContentTypes: ['image/jpeg', 'image/png', 'application/pdf'] as const,
  maxBytes: 10 * 1024 * 1024,
  /** Per report. A phone photographing a lab sheet rarely needs more. */
  maxPages: 10,
} as const;

export const reportContentTypeSchema = z.enum(REPORT_UPLOAD.allowedContentTypes);
export type ReportContentType = z.infer<typeof reportContentTypeSchema>;

/**
 * Step one of the upload: ask for somewhere to put a page.
 *
 * Two steps rather than one because a phone photo of a lab report is several
 * megabytes, and pushing that through the API would tie up a request handler
 * for the length of a mobile upload. The app PUTs the bytes straight at the
 * returned URL and then tells us the keys.
 */
export const createUploadBodySchema = z.object({
  contentType: reportContentTypeSchema,
  size: z.number().int().min(1).max(REPORT_UPLOAD.maxBytes),
});
export type CreateUploadBody = z.infer<typeof createUploadBodySchema>;

export const uploadTicketSchema = z.object({
  /** PUT the bytes here, with the same Content-Type that was asked for. */
  uploadUrl: z.string(),
  /** Hand this back in pageKeys once the PUT succeeds. */
  fileKey: z.string(),
  expiresAt: z.coerce.date(),
});
export type UploadTicket = z.infer<typeof uploadTicketSchema>;

export const createReportBodySchema = z.object({
  type: reportTypeSchema,
  testName: z.string().trim().min(1).max(200),
  /** The day the test was done, which is rarely the day it is uploaded. */
  testDate: dateStringSchema,
  pageKeys: z.array(z.string().min(1)).min(1).max(REPORT_UPLOAD.maxPages),
  visitId: objectIdSchema.nullable().optional(),
});
export type CreateReportBody = z.infer<typeof createReportBodySchema>;

export const reportViewSchema = z.object({
  id: objectIdSchema,
  patientId: objectIdSchema,
  visitId: objectIdSchema.nullable(),
  type: reportTypeSchema,
  testName: z.string(),
  testDate: dateStringSchema,
  /** How many pages, not the pages themselves. */
  pages: z.number().int().min(1),
  uploadedBy: objectIdSchema,
  /** Null until the doctor has looked at it. */
  reviewedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type ReportView = z.infer<typeof reportViewSchema>;

/** Reading one back: the same thing, with a short-lived link per page. */
export const reportDetailViewSchema = reportViewSchema.extend({
  pageUrls: z.array(z.object({ url: z.string(), expiresAt: z.coerce.date() })),
});
export type ReportDetailView = z.infer<typeof reportDetailViewSchema>;

export const listReportsQuerySchema = z.object({
  type: reportTypeSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;
