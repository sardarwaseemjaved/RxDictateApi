import { scopeFrom } from '../core/tenancy';
import * as prescriptionService from '../services/prescription.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type {
  CreatePrescriptionBody,
  ListPrescriptionsQuery,
  PatchPrescriptionBody,
  RevisePrescriptionBody,
} from '../shared/prescription.schema';

export const listPrescriptions = catchAsync(async (req, res) => {
  const { prescriptions, meta } = await prescriptionService.listPrescriptions(
    scopeFrom(req),
    parsedQuery<ListPrescriptionsQuery>(req),
  );
  sendData(res, prescriptions, meta);
});

export const getPrescription = catchAsync(async (req, res) => {
  sendData(res, await prescriptionService.getPrescription(scopeFrom(req), req.params.id));
});

export const createPrescription = catchAsync(async (req, res) => {
  const { prescription, created } = await prescriptionService.createPrescription(
    scopeFrom(req),
    req.body as CreatePrescriptionBody,
  );
  // 201 for a draft this call made, 200 for the one that was already open.
  if (created) {
    sendCreated(res, prescription);
  } else {
    sendData(res, prescription);
  }
});

export const patchPrescription = catchAsync(async (req, res) => {
  sendData(
    res,
    await prescriptionService.patchPrescription(scopeFrom(req), req.params.id, req.body as PatchPrescriptionBody),
  );
});

export const approvePrescription = catchAsync(async (req, res) => {
  // The doctor's name is frozen onto the page, so it comes from the signed-in
  // user rather than from anything the client sent.
  sendData(res, await prescriptionService.approvePrescription(scopeFrom(req), req.params.id, req.auth!.name));
});

export const revisePrescription = catchAsync(async (req, res) => {
  sendCreated(
    res,
    await prescriptionService.revisePrescription(scopeFrom(req), req.params.id, req.body as RevisePrescriptionBody),
  );
});

export const cancelPrescription = catchAsync(async (req, res) => {
  sendData(res, await prescriptionService.cancelPrescription(scopeFrom(req), req.params.id));
});

export const previewPrescription = catchAsync(async (req, res) => {
  // meta.format is kept for the clients already reading it; data.contentType
  // is the authoritative answer and says what the file actually is.
  const { driver, ...signed } = await prescriptionService.previewPrescription(scopeFrom(req), req.params.id);
  sendData(res, signed, { format: driver });
});

export const prescriptionPdf = catchAsync(async (req, res) => {
  const { driver, ...signed } = await prescriptionService.prescriptionPdf(scopeFrom(req), req.params.id);
  sendData(res, signed, { format: driver });
});
