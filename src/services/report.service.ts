import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { Report, Visit, type IReport, type ReportDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import { reportExtensionFor, reportPageKey, signedGetUrl, signedPutUrl } from '../core/storage';
import type {
  CreateReportBody,
  CreateUploadBody,
  ListReportsQuery,
  ReportDetailView,
  ReportView,
  UploadTicket,
} from '../shared/report.schema';
import type { PageMeta } from '../shared/response';
import { findPatient, findPatientOrFail } from './patient.service';

const reports = new BaseRepository<IReport>(Report);

export const toReportView = (report: ReportDoc): ReportView => ({
  id: String(report._id),
  patientId: String(report.patientId),
  visitId: report.visitId ? String(report.visitId) : null,
  type: report.type,
  testName: report.testName,
  testDate: report.testDate,
  pages: report.pageKeys.length,
  uploadedBy: String(report.uploadedBy),
  reviewedAt: report.reviewedAt,
  reviewedBy: report.reviewedBy ? String(report.reviewedBy) : null,
  createdAt: report.createdAt,
});

/**
 * Step one: somewhere to PUT one page.
 *
 * The key is handed out before the report exists and is only claimed in step
 * two, so an abandoned upload leaves an orphaned object and no row. That is
 * the right way round - the alternative is a report row pointing at bytes that
 * never arrived.
 *
 * The declared size goes into the signature under the local driver, so the
 * link cannot be used to put anything bigger on the server's disk.
 */
export const createUpload = async (scope: Scope, body: CreateUploadBody): Promise<UploadTicket> => {
  const key = reportPageKey(scope.practiceId, randomBytes(12).toString('hex'), reportExtensionFor(body.contentType));
  const signed = await signedPutUrl(key, body.contentType, { size: body.size });

  return { uploadUrl: signed.url, fileKey: key, expiresAt: signed.expiresAt };
};

/** A key has to be one this practice was given, or a report could point anywhere. */
const assertOwnKeys = (scope: Scope, pageKeys: string[]): void => {
  const prefix = `${String(scope.practiceId)}/reports/pages/`;
  const foreign = pageKeys.find((key) => !key.startsWith(prefix));
  if (foreign) {
    throw new AppError('VALIDATION_ERROR', 'One of those page keys was not issued to this clinic.');
  }
};

export const createReport = async (scope: Scope, patientId: string, body: CreateReportBody): Promise<ReportView> => {
  const patient = await findPatientOrFail(scope, patientId);

  if (body.visitId) {
    const visit = await Visit.findOne({ _id: body.visitId, practiceId: scope.practiceId, deletedAt: null });
    if (!visit) {
      throw AppError.notFound('Visit');
    }
  }

  assertOwnKeys(scope, body.pageKeys);

  const report = await reports.create(scope, {
    patientId: patient._id,
    visitId: body.visitId ? new Types.ObjectId(body.visitId) : null,
    type: body.type,
    testName: body.testName,
    testDate: body.testDate,
    pageKeys: body.pageKeys,
    uploadedBy: scope.actorId,
    reviewedAt: null,
    reviewedBy: null,
  });

  const after = toReportView(report);
  await writeAudit(scope, { action: 'report.create', entity: 'report', entityId: report._id, after });
  emit('report.uploaded', {
    practiceId: scope.practiceId,
    patientId: patient._id,
    reportId: report._id,
    actorId: scope.actorId,
  });

  return after;
};

export const listReports = async (
  scope: Scope,
  patientId: string,
  query: ListReportsQuery,
): Promise<{ reports: ReportView[]; meta: PageMeta }> => {
  const patient = await findPatientOrFail(scope, patientId);

  const result = await reports.paginate(
    scope,
    { patientId: patient._id, ...(query.type ? { type: query.type } : {}) },
    { page: query.page, limit: query.limit, sortBy: 'testDate:desc' },
  );

  return {
    reports: result.results.map(toReportView),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

/**
 * One report, with a short-lived link per page. A report is part of its
 * patient's record, so it is NOT_FOUND to anyone who could not open the
 * patient.
 */
export const getReport = async (scope: Scope, id: string): Promise<ReportDetailView> => {
  const report = await reports.findByIdOrFail(scope, id, 'Report');
  if (!(await findPatient(scope, report.patientId))) {
    throw AppError.notFound('Report');
  }

  // Each page carries its own content type: a report can be a photographed
  // page and a PDF in the same record.
  const pageUrls = await Promise.all(report.pageKeys.map((key) => signedGetUrl(key)));

  return { ...toReportView(report), pageUrls };
};

/**
 * The doctor has looked at it. This is what takes a report out of "New" and
 * the patient out of the newReports filter.
 *
 * Idempotent, and the first look is the one kept: reviewing again returns the
 * report as it is. The filter on reviewedAt makes that hold when two devices
 * tap at once - only one update can match a null.
 */
export const reviewReport = async (scope: Scope, id: string): Promise<ReportView> => {
  const reviewed = await Report.findOneAndUpdate(
    reports.scopedFilter(scope, { _id: id, reviewedAt: null }),
    { $set: { reviewedAt: new Date(), reviewedBy: scope.actorId } },
    { new: true },
  );

  if (!reviewed) {
    return toReportView(await reports.findByIdOrFail(scope, id, 'Report'));
  }

  const after = toReportView(reviewed);
  await writeAudit(scope, {
    action: 'report.review',
    entity: 'report',
    entityId: reviewed._id,
    before: { reviewedAt: null },
    after: { reviewedAt: after.reviewedAt, reviewedBy: after.reviewedBy },
  });

  return after;
};

export default { createUpload, createReport, listReports, getReport, reviewReport, toReportView };
