import { scopeFrom } from '../core/tenancy';
import * as practiceService from '../services/practice.service';
import catchAsync from '../utils/catchAsync';
import { sendCreated, sendData } from '../utils/response';
import type { UpdatePracticeBody } from '../shared/practice.schema';
import type { CreatePracticeBody } from '../shared/auth.schema';

export const getPractice = catchAsync(async (req, res) => {
  sendData(res, await practiceService.getPractice(scopeFrom(req)));
});

export const updatePractice = catchAsync(async (req, res) => {
  sendData(res, await practiceService.updatePractice(scopeFrom(req), req.body as UpdatePracticeBody));
});

/** No scopeFrom: this runs before the caller has a practice to scope to. */
export const createMyPractice = catchAsync(async (req, res) => {
  sendCreated(res, await practiceService.createMyPractice(req.auth!.userId, req.body as CreatePracticeBody));
});
