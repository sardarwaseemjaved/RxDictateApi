import { idParamSchema } from '../shared/common';
import {
  createFromTemplateBodySchema,
  createPrescriptionBodySchema,
  listPrescriptionsQuerySchema,
  patchPrescriptionBodySchema,
  revisePrescriptionBodySchema,
} from '../shared/prescription.schema';

export const listPrescriptions = { query: listPrescriptionsQuerySchema };
export const getPrescription = { params: idParamSchema };
export const createPrescription = { body: createPrescriptionBodySchema };
/** `:id` is the template's. */
export const createFromTemplate = { params: idParamSchema, body: createFromTemplateBodySchema };
export const patchPrescription = { params: idParamSchema, body: patchPrescriptionBodySchema };
export const approvePrescription = { params: idParamSchema };
export const revisePrescription = { params: idParamSchema, body: revisePrescriptionBodySchema };
export const prescriptionPdf = { params: idParamSchema };
export const previewPrescription = { params: idParamSchema };
export const cancelPrescription = { params: idParamSchema };
