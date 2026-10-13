import { idParamSchema } from '../shared/common';
import { createVisitBodySchema, listVisitsQuerySchema, updateVisitBodySchema } from '../shared/visit.schema';

export const listVisits = { query: listVisitsQuerySchema };
export const createVisit = { body: createVisitBodySchema };
export const updateVisit = { params: idParamSchema, body: updateVisitBodySchema };
