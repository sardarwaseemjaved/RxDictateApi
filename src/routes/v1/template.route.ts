import express from 'express';
import requireAuth from '../../middlewares/requireAuth';
import notImplemented from '../../middlewares/notImplemented';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

// practice.features.templates is false by default; the collection and its index
// already exist.
router.get('/', requireAuth, resolvePractice, requireCan('template.read'), notImplemented('Templates'));
router.post('/', requireAuth, resolvePractice, requireCan('template.create'), notImplemented('Templates'));

export default router;
