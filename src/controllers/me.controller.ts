import * as meService from '../services/me.service';
import catchAsync from '../utils/catchAsync';
import { sendData } from '../utils/response';
import type { UpdateMeBody } from '../shared/me.schema';

export const getMe = catchAsync(async (req, res) => {
  sendData(res, await meService.getMe(req.auth!.userId));
});

export const updateMe = catchAsync(async (req, res) => {
  sendData(res, await meService.updateMe(req.auth!.userId, req.body as UpdateMeBody));
});
