import { idParamSchema } from '../shared/common';
import { createDrugBodySchema, searchDrugsQuerySchema, updateDrugBodySchema } from '../shared/drug.schema';

export const searchDrugs = { query: searchDrugsQuerySchema };
export const createDrug = { body: createDrugBodySchema };
export const updateDrug = { params: idParamSchema, body: updateDrugBodySchema };
export const proposeDrug = { params: idParamSchema };
