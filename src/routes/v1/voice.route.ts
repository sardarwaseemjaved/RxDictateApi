import express from 'express';
import { voiceController } from '../../controllers';
import { voiceValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolveLocation, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Addressed by segment rather than by prescription, which is why these two are
 * not under /prescriptions: the app has the segment id from the session it is
 * polling.
 */
router.post(
  '/segments/:id/retry',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('voice.dictate'),
  validate(voiceValidation.retrySegment),
  voiceController.retrySegment,
);

/** The recording itself, as a signed URL. 404 once retention has deleted it. */
router.get(
  '/segments/:id/audio',
  requireAuth,
  resolvePractice,
  resolveLocation,
  requireCan('voice.read'),
  validate(voiceValidation.segmentAudio),
  voiceController.segmentAudio,
);

export default router;
