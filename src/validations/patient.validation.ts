import { idParamSchema } from '../shared/common';
import { createPatientBodySchema, searchPatientsQuerySchema, updatePatientBodySchema } from '../shared/patient.schema';

export const searchPatients = { query: searchPatientsQuerySchema };
export const getPatient = { params: idParamSchema };
export const createPatient = { body: createPatientBodySchema };
export const updatePatient = { params: idParamSchema, body: updatePatientBodySchema };
