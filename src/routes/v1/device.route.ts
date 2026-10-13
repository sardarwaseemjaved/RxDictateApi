import express from 'express';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import notImplemented from '../../middlewares/notImplemented';
import { notificationValidation } from '../../validations';

const router = express.Router();

/** A push token belongs to a person, not a practice, so this needs no practice header. */
router.post('/', requireAuth, validate(notificationValidation.registerDevice), notImplemented('Push notifications'));

export default router;
