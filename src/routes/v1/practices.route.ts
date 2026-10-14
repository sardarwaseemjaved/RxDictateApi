import express from 'express';
import { practiceController } from '../../controllers';
import { practiceValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';

const router = express.Router();

/**
 * Set up a clinic for the signed-in caller.
 *
 * Plural, and deliberately not under /practice: everything there resolves an
 * X-Practice-Id, and this is the one call made by somebody who has none. No
 * resolvePractice and no can(), for the same reason - there is no membership
 * yet to check a role against.
 */
router.post('/', requireAuth, validate(practiceValidation.createMyPractice), practiceController.createMyPractice);

export default router;
