import { idParamSchema } from '../shared/common';
import {
  createVisitBodySchema,
  listVisitsQuerySchema,
  moveVisitBodySchema,
  updateVisitBodySchema,
} from '../shared/visit.schema';

export const listVisits = { query: listVisitsQuerySchema };
export const createVisit = { body: createVisitBodySchema };
export const updateVisit = { params: idParamSchema, body: updateVisitBodySchema };
export const moveVisit = { params: idParamSchema, body: moveVisitBodySchema };
