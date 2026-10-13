import { idParamSchema } from '../shared/common';
import { addSegmentBodySchema } from '../shared/voice.schema';

export const addSegment = { params: idParamSchema, body: addSegmentBodySchema };
export const getVoiceSession = { params: idParamSchema };
export const retrySegment = { params: idParamSchema };
export const segmentAudio = { params: idParamSchema };
