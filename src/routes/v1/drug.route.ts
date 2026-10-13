import express from 'express';
import { drugController } from '../../controllers';
import { drugValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * The formulary is shared across clinics - a brand name means the same thing
 * everywhere - so this is the one list that is not practice data. It still sits
 * behind resolvePractice, because only a member of some practice may search it.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('drug.search'),
  validate(drugValidation.searchDrugs),
  drugController.searchDrugs,
);

export default router;
