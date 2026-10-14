import { scopeFrom } from '../core/tenancy';
import * as vitalsService from '../services/vitals.service';
import catchAsync from '../utils/catchAsync';
import { sendData } from '../utils/response';
import type { RecordVitalsBody } from '../shared/vitals.schema';

export const getVitals = catchAsync(async (req, res) => {
  sendData(res, await vitalsService.getVitals(scopeFrom(req), req.params.id));
});

export const recordVitals = catchAsync(async (req, res) => {
  sendData(res, await vitalsService.recordVitals(scopeFrom(req), req.params.id, req.body as RecordVitalsBody));
});
