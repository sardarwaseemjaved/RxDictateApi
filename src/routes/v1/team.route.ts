import express from 'express';
import { teamController } from '../../controllers';
import { teamValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

router.get(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('member.read'),
  validate(teamValidation.listMembers),
  teamController.listMembers,
);

// By phone number. There is no invite code anywhere in this product.
router.post(
  '/',
  requireAuth,
  resolvePractice,
  requireCan('member.add'),
  validate(teamValidation.addMember),
  teamController.addMember,
);

router.patch(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('member.update'),
  validate(teamValidation.updateMember),
  teamController.updateMember,
);

// Sets the membership to removed; her past actions stay in the audit log.
router.delete(
  '/:id',
  requireAuth,
  resolvePractice,
  requireCan('member.remove'),
  validate(teamValidation.removeMember),
  teamController.removeMember,
);

export default router;
