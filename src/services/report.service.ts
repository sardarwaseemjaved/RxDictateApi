import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import { Patient, Report, Visit, type IReport, type ReportDoc } from '../models';
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
  createdAt: report.createdAt,
});

/**
 * Step one: somewhere to PUT one page.
 *
 * The key is handed out before the report exists and is only claimed in step
 * two, so an abandoned upload leaves an orphaned object and no row. That is
 * the right way round - the alternative is a report row pointing at bytes that
 * never arrived.
 */
export const createUpload = async (scope: Scope, body: CreateUploadBody): Promise<UploadTicket> => {
  const key = reportPageKey(scope.practiceId, randomBytes(12).toString('hex'), reportExtensionFor(body.contentType));
  const signed = await signedPutUrl(key, body.contentType);

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
  const patient = await Patient.findOne({ _id: patientId, practiceId: scope.practiceId, deletedAt: null });
  if (!patient) {
    throw AppError.notFound('Patient');
  }

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
  const patient = await Patient.findOne({ _id: patientId, practiceId: scope.practiceId, deletedAt: null });
  if (!patient) {
    throw AppError.notFound('Patient');
  }

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

/** One report, with a short-lived link per page. */
export const getReport = async (scope: Scope, id: string): Promise<ReportDetailView> => {
  const report = await reports.findByIdOrFail(scope, id, 'Report');

  // Each page carries its own content type: a report can be a photographed
  // page and a PDF in the same record.
  const pageUrls = await Promise.all(report.pageKeys.map((key) => signedGetUrl(key)));

  return { ...toReportView(report), pageUrls };
};

export default { createUpload, createReport, listReports, getReport, toReportView };
