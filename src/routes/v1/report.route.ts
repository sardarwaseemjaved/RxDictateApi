import express from 'express';
import requireAuth from '../../middlewares/requireAuth';
import notImplemented from '../../middlewares/notImplemented';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/** Uploading one lives under /patients/:id/reports; this is reading one back. */
router.get('/:id', requireAuth, resolvePractice, requireCan('report.read'), notImplemented('Reports'));

export default router;
