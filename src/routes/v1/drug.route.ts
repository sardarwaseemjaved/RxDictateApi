import express from 'express';
import { drugController } from '../../controllers';
import { drugValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan, requireCanFor } from '../../core/permissions';
import type { CreateDrugBody } from '../../shared/drug.schema';

const router = express.Router();

/**
 * Suggestions, by the caller's `medicines.source`. What each caller can find is
 * decided in drugAccess.service: the national catalog, their clinic's own items
 * and their own typed rows, and never anybody else's.
 */
router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('drug.search'),
  validate(drugValidation.searchDrugs),
  drugController.searchDrugs,
);

// Which list it is for decides who may add it, so that check reads the parsed body.
router.post(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('drugList.read'),
  validate(drugValidation.createDrug),
  requireCanFor((req) => ((req.body as CreateDrugBody).for === 'clinic' ? 'drugList.clinic.manage' : 'drugList.own.manage')),
  drugController.createDrug,
);

// Who may correct a row depends on the row, so the service decides.
router.patch(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('drugList.read'),
  validate(drugValidation.updateDrug),
  drugController.updateDrug,
);

export default router;
