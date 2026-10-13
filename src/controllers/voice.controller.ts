import { scopeFrom } from '../core/tenancy';
import * as voiceService from '../services/voice.service';
import catchAsync from '../utils/catchAsync';
import { sendCreated, sendData } from '../utils/response';
import type { AddSegmentBody } from '../shared/voice.schema';

export const addSegment = catchAsync(async (req, res) => {
  // Accepted and queued: transcription runs in the background and the app polls
  // GET /prescriptions/:id/voice for the result.
  sendCreated(res, await voiceService.addSegment(scopeFrom(req), req.params.id, req.body as AddSegmentBody));
});

export const getVoiceSession = catchAsync(async (req, res) => {
  sendData(res, await voiceService.getVoiceSession(scopeFrom(req), req.params.id));
});

export const retrySegment = catchAsync(async (req, res) => {
  sendData(res, await voiceService.retrySegment(scopeFrom(req), req.params.id));
});

export const segmentAudio = catchAsync(async (req, res) => {
  sendData(res, await voiceService.segmentAudioUrl(scopeFrom(req), req.params.id));
});
