import { idParamSchema } from '../shared/common';
import { createPatientBodySchema, searchPatientsQuerySchema, updatePatientBodySchema } from '../shared/patient.schema';
import { listHistoryQuerySchema } from '../shared/history.schema';

export const searchPatients = { query: searchPatientsQuerySchema };
export const getPatient = { params: idParamSchema };
export const createPatient = { body: createPatientBodySchema };
export const updatePatient = { params: idParamSchema, body: updatePatientBodySchema };

// Still 501; the shape is settled so the app can be written against it.
export const getHistory = { params: idParamSchema, query: listHistoryQuerySchema };
