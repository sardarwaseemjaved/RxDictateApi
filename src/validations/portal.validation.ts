import { idParamSchema, paginationQuerySchema } from '../shared/common';
import {
  portalCreateReportBodySchema,
  portalLinkBodySchema,
  portalLinkParamsSchema,
  portalListAppointmentsQuerySchema,
  portalRecordParamsSchema,
  updatePatientPortalBodySchema,
} from '../shared/portal.schema';
import { createUploadBodySchema } from '../shared/report.schema';

export const link = { body: portalLinkBodySchema };
export const oneLink = { params: portalLinkParamsSchema };
export const page = { params: portalLinkParamsSchema, query: paginationQuerySchema };
export const oneRecord = { params: portalRecordParamsSchema };
export const listAppointments = { params: portalLinkParamsSchema, query: portalListAppointmentsQuerySchema };
export const createUpload = { params: portalLinkParamsSchema, body: createUploadBodySchema };
export const createReport = { params: portalLinkParamsSchema, body: portalCreateReportBodySchema };

export const patientPortal = { params: idParamSchema };
export const updatePatientPortal = { params: idParamSchema, body: updatePatientPortalBodySchema };
