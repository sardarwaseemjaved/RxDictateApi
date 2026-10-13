import express from 'express';
import { meController } from '../../controllers';
import { meValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';

const router = express.Router();

/**
 * Signed in, but no practice yet: this is the call that tells the app which
 * practice ids exist, so it cannot require one of them as a header.
 */
router.get('/', requireAuth, meController.getMe);
router.patch('/', requireAuth, validate(meValidation.updateMe), meController.updateMe);

export default router;
