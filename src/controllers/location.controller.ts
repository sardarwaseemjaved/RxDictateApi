import { scopeFrom } from '../core/tenancy';
import * as locationService from '../services/location.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { CreateLocationBody, ListLocationsQuery, UpdateLocationBody } from '../shared/location.schema';

export const listLocations = catchAsync(async (req, res) => {
  sendData(res, await locationService.listLocations(scopeFrom(req), parsedQuery<ListLocationsQuery>(req)));
});

export const createLocation = catchAsync(async (req, res) => {
  sendCreated(res, await locationService.createLocation(scopeFrom(req), req.body as CreateLocationBody));
});

export const updateLocation = catchAsync(async (req, res) => {
  sendData(res, await locationService.updateLocation(scopeFrom(req), req.params.id, req.body as UpdateLocationBody));
});

export const archiveLocation = catchAsync(async (req, res) => {
  sendData(res, await locationService.archiveLocation(scopeFrom(req), req.params.id));
});
