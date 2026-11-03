import {
  drugListItemParamsSchema,
  drugListParamsSchema,
  listDrugListQuerySchema,
  putDrugListItemBodySchema,
} from '../shared/drug.schema';

export const listItems = { params: drugListParamsSchema, query: listDrugListQuerySchema };
export const putItem = { params: drugListItemParamsSchema, body: putDrugListItemBodySchema };
export const removeItem = { params: drugListItemParamsSchema };
