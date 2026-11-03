import express from 'express';
import type { Request } from 'express';
import { drugListController } from '../../controllers';
import { drugListValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan, requireCanFor } from '../../core/permissions';
import type { Action } from '../../shared/roles';

const router = express.Router();

/**
 * `:owner` is `me` or `clinic`, and there is no way to name another doctor's
 * list: `me` is always the caller's own, in the clinic X-Practice-Id names.
 */
const manages = (req: Request): Action => (req.params.owner === 'clinic' ? 'drugList.clinic.manage' : 'drugList.own.manage');

router.get(
  '/:owner',
  requireAuth,
  resolvePractice,
  requireCan('drugList.read'),
  validate(drugListValidation.listItems),
  drugListController.listItems,
);

router.put(
  '/:owner/items/:drugId',
  requireAuth,
  resolvePractice,
  requireCanFor(manages),
  validate(drugListValidation.putItem),
  drugListController.putItem,
);

router.delete(
  '/:owner/items/:drugId',
  requireAuth,
  resolvePractice,
  requireCanFor(manages),
  validate(drugListValidation.removeItem),
  drugListController.removeItem,
);

export default router;
