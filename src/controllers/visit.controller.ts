import { scopeFrom } from '../core/tenancy';
import * as visitService from '../services/visit.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { CreateVisitBody, ListVisitsQuery, UpdateVisitBody } from '../shared/visit.schema';

export const listVisits = catchAsync(async (req, res) => {
  sendData(res, await visitService.listVisits(scopeFrom(req), parsedQuery<ListVisitsQuery>(req)));
});

export const createVisit = catchAsync(async (req, res) => {
  sendCreated(res, await visitService.createVisit(scopeFrom(req), req.body as CreateVisitBody));
});

export const updateVisit = catchAsync(async (req, res) => {
  sendData(res, await visitService.updateVisit(scopeFrom(req), req.params.id, req.body as UpdateVisitBody));
});
