import { idParamSchema } from '../shared/common';
import { createReportBodySchema, createUploadBodySchema, listReportsQuerySchema } from '../shared/report.schema';

export const createUpload = { body: createUploadBodySchema };
export const createReport = { params: idParamSchema, body: createReportBodySchema };
export const listReports = { params: idParamSchema, query: listReportsQuerySchema };
export const getReport = { params: idParamSchema };
