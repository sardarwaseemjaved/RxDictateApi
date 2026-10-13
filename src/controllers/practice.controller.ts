import { scopeFrom } from '../core/tenancy';
import * as practiceService from '../services/practice.service';
import catchAsync from '../utils/catchAsync';
import { sendData } from '../utils/response';
import type { UpdatePracticeBody } from '../shared/practice.schema';

export const getPractice = catchAsync(async (req, res) => {
  sendData(res, await practiceService.getPractice(scopeFrom(req)));
});

export const updatePractice = catchAsync(async (req, res) => {
  sendData(res, await practiceService.updatePractice(scopeFrom(req), req.body as UpdatePracticeBody));
});
