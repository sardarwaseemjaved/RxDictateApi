import type { Request } from 'express';
import * as patientPortalService from '../services/patientPortal.service';
import * as portalService from '../services/portal.service';
import { scopeFrom } from '../core/tenancy';
import type {
  PortalCreateReportBody,
  PortalLinkBody,
  PortalListAppointmentsQuery,
  UpdatePatientPortalBody,
} from '../shared/portal.schema';
import type { CreateUploadBody } from '../shared/report.schema';
import type { PaginationQuery } from '../shared/common';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';

const userOf = (req: Request): portalService.PortalUser => ({ userId: req.auth!.userId, phone: req.auth!.phone });

/* The patient's own area. */

export const previewLink = catchAsync(async (req, res) => {
  sendData(res, await portalService.previewLink(userOf(req), req.body as PortalLinkBody));
});

export const createLink = catchAsync(async (req, res) => {
  const { link, created } = await portalService.createLink(userOf(req), req.body as PortalLinkBody);
  if (created) {
    sendCreated(res, link);
  } else {
    sendData(res, link);
  }
});

export const listLinks = catchAsync(async (req, res) => {
  sendData(res, await portalService.listLinks(userOf(req)));
});

export const removeLink = catchAsync(async (req, res) => {
  sendData(res, await portalService.removeOwnLink(userOf(req), req.params.linkId));
});

export const listPrescriptions = catchAsync(async (req, res) => {
  const { prescriptions, meta } = await portalService.listPrescriptions(req.portal!, parsedQuery<PaginationQuery>(req));
  sendData(res, prescriptions, meta);
});

export const getPrescription = catchAsync(async (req, res) => {
  sendData(res, await portalService.getPrescription(req.portal!, req.params.id));
});

export const prescriptionPdf = catchAsync(async (req, res) => {
  sendData(res, await portalService.prescriptionPdf(req.portal!, req.params.id));
});

export const listReports = catchAsync(async (req, res) => {
  const { reports, meta } = await portalService.listReports(req.portal!, parsedQuery<PaginationQuery>(req));
  sendData(res, reports, meta);
});

export const getReport = catchAsync(async (req, res) => {
  sendData(res, await portalService.getReport(req.portal!, req.params.id));
});

export const listAppointments = catchAsync(async (req, res) => {
  const { appointments, meta } = await portalService.listAppointments(
    req.portal!,
    parsedQuery<PortalListAppointmentsQuery>(req),
  );
  sendData(res, appointments, meta);
});

export const listFollowUps = catchAsync(async (req, res) => {
  const { followUps, meta } = await portalService.listFollowUps(req.portal!, parsedQuery<PaginationQuery>(req));
  sendData(res, followUps, meta);
});

export const listVitals = catchAsync(async (req, res) => {
  const { vitals, meta } = await portalService.listVitals(req.portal!, parsedQuery<PaginationQuery>(req));
  sendData(res, vitals, meta);
});

export const createUpload = catchAsync(async (req, res) => {
  sendCreated(res, await portalService.createUpload(req.portal!, req.body as CreateUploadBody));
});

export const createReport = catchAsync(async (req, res) => {
  sendCreated(res, await portalService.createReport(req.portal!, req.body as PortalCreateReportBody));
});

/* The clinic's controls, under /patients/:id/portal. */

export const getPatientPortal = catchAsync(async (req, res) => {
  sendData(res, await patientPortalService.getPortal(scopeFrom(req), req.params.id));
});

export const sendPatientInvite = catchAsync(async (req, res) => {
  sendData(res, await patientPortalService.sendInvite(scopeFrom(req), req.params.id));
});

export const updatePatientPortal = catchAsync(async (req, res) => {
  sendData(res, await patientPortalService.updatePortal(scopeFrom(req), req.params.id, req.body as UpdatePatientPortalBody));
});

export const removePatientLink = catchAsync(async (req, res) => {
  sendData(res, await patientPortalService.removeLink(scopeFrom(req), req.params.id));
});
