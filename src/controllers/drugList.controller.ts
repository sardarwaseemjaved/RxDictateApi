import { auditScope } from '../core/audit';
import { scopeFrom } from '../core/tenancy';
import * as drugListService from '../services/drugList.service';
import catchAsync from '../utils/catchAsync';
import { parsedBody, parsedParams, parsedQuery } from '../utils/request';
import { sendData } from '../utils/response';
import type { DrugListItemParams, DrugListOwner, ListDrugListQuery, PutDrugListItemBody } from '../shared/drug.schema';

export const listItems = catchAsync(async (req, res) => {
  const { owner } = parsedParams<{ owner: DrugListOwner }>(req);
  const { items, meta } = await drugListService.listItems(scopeFrom(req), owner, parsedQuery<ListDrugListQuery>(req));
  sendData(res, items, meta);
});

export const putItem = catchAsync(async (req, res) => {
  const { owner, drugId } = parsedParams<DrugListItemParams>(req);
  sendData(res, await drugListService.putItem(auditScope(req), owner, drugId, parsedBody<PutDrugListItemBody>(req)));
});

export const removeItem = catchAsync(async (req, res) => {
  const { owner, drugId } = parsedParams<DrugListItemParams>(req);
  sendData(res, await drugListService.removeItem(auditScope(req), owner, drugId));
});
