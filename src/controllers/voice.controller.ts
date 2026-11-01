import { scopeFrom } from '../core/tenancy';
import * as voiceService from '../services/voice.service';
import catchAsync from '../utils/catchAsync';
import { sendCreated, sendData } from '../utils/response';
import type { AddSegmentBody } from '../shared/voice.schema';
import logger from '../config/logger';

export const addSegment = catchAsync(async (req, res) => {
  const body = req.body as AddSegmentBody;
  logger.info(
    `[voice] upload request received requestId=${req.id ?? '-'} prescriptionId=${req.params.id} ` +
      `seq=${body.seq} durationMs=${body.durationMs} contentType=${body.contentType} ` +
      `base64Chars=${body.audioBase64.length}`,
  );

  // Accepted and queued: transcription runs in the background and the app polls
  // GET /prescriptions/:id/voice for the result.
  sendCreated(res, await voiceService.addSegment(scopeFrom(req), req.params.id, body));
});

export const getVoiceSession = catchAsync(async (req, res) => {
  // This is a live polling resource. Ignore validators from an older cached
  // response so Express cannot turn the JSON response into a bodyless 304.
  res.setHeader('Cache-Control', 'no-store');
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  sendData(res, await voiceService.getVoiceSession(scopeFrom(req), req.params.id));
});

export const retrySegment = catchAsync(async (req, res) => {
  logger.info(`[voice] retry request received requestId=${req.id ?? '-'} segmentId=${req.params.id}`);
  sendData(res, await voiceService.retrySegment(scopeFrom(req), req.params.id));
});

export const segmentAudio = catchAsync(async (req, res) => {
  sendData(res, await voiceService.segmentAudioUrl(scopeFrom(req), req.params.id));
});
