import { auditScope } from '../core/audit';
import { scopeFrom } from '../core/tenancy';
import * as drugService from '../services/drug.service';
import * as submissionService from '../services/submission.service';
import catchAsync from '../utils/catchAsync';
import { parsedBody, parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { CreateDrugBody, SearchDrugsQuery, UpdateDrugBody } from '../shared/drug.schema';

export const searchDrugs = catchAsync(async (req, res) => {
  sendData(res, await drugService.searchDrugs(scopeFrom(req), parsedQuery<SearchDrugsQuery>(req)));
});

export const createDrug = catchAsync(async (req, res) => {
  const { item, created } = await drugService.createDrug(auditScope(req), parsedBody<CreateDrugBody>(req));
  if (created) {
    sendCreated(res, item);
  } else {
    sendData(res, item);
  }
});

export const updateDrug = catchAsync(async (req, res) => {
  sendData(res, await drugService.updateDrug(auditScope(req), req.params.id, parsedBody<UpdateDrugBody>(req)));
});

export const proposeDrug = catchAsync(async (req, res) => {
  sendCreated(res, await submissionService.proposeDrug(auditScope(req), req.params.id));
});
