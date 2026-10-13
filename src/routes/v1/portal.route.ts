import express from 'express';
import notImplemented from '../../middlewares/notImplemented';

const router = express.Router();

/**
 * The patient's own read-only view, later.
 *
 * No requireAuth: a patient will not hold a membership in a practice, so the
 * portal needs its own way in and the chain above does not fit. Everything under
 * here answers 501 until that exists.
 */
router.use('/', notImplemented('The patient portal'));

export default router;
