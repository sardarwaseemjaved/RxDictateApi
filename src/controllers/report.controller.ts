import { scopeFrom } from '../core/tenancy';
import * as reportService from '../services/report.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { CreateReportBody, CreateUploadBody, ListReportsQuery } from '../shared/report.schema';

export const createUpload = catchAsync(async (req, res) => {
  sendCreated(res, await reportService.createUpload(scopeFrom(req), req.body as CreateUploadBody));
});

export const createReport = catchAsync(async (req, res) => {
  sendCreated(res, await reportService.createReport(scopeFrom(req), req.params.id, req.body as CreateReportBody));
});

export const listReports = catchAsync(async (req, res) => {
  const { reports, meta } = await reportService.listReports(
    scopeFrom(req),
    req.params.id,
    parsedQuery<ListReportsQuery>(req),
  );
  sendData(res, reports, meta);
});

export const getReport = catchAsync(async (req, res) => {
  sendData(res, await reportService.getReport(scopeFrom(req), req.params.id));
});

export const reviewReport = catchAsync(async (req, res) => {
  sendData(res, await reportService.reviewReport(scopeFrom(req), req.params.id));
});
