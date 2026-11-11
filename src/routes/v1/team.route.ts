import express, { type RequestHandler } from 'express';
import { teamController } from '../../controllers';
import { teamValidation } from '../../validations';
import requireAuth from '../../middlewares/requireAuth';
import validate from '../../middlewares/validate';
import { ANY_ORGANISATION, resolveOrganisation, resolvePractice } from '../../core/tenancy';
import { requireCan } from '../../core/permissions';

const router = express.Router();

/**
 * Each organisation's own staff, for every kind: a clinic's doctors, assistants
 * and medicine managers, a company's admins and editors, and RxDictate's own.
 * The tenancy check is the same one every route mounts - here it serves every
 * kind - and the permissions table says who runs each: a doctor, a
 * companyAdmin, a platformAdmin.
 *
 * A clinic's requests and answers are exactly what they were. A company or the
 * platform adds by phone with one of its own roles and no locations, and a
 * role never changes, so PATCH stays a clinic's.
 */

// A clinic's body has locations; everyone else's has none.
const validateAdd: RequestHandler = (req, res, next) =>
  validate(req.ctx?.organisationType === 'clinic' ? teamValidation.addMember : teamValidation.addOrganisationMember)(
    req,
    res,
    next,
  );

router.get(
  '/',
  requireAuth,
  resolveOrganisation(ANY_ORGANISATION),
  requireCan('member.read'),
  validate(teamValidation.listMembers),
  teamController.listMembers,
);

// By phone number. There is no invite code anywhere in this product.
router.post(
  '/',
  requireAuth,
  resolveOrganisation(ANY_ORGANISATION),
  requireCan('member.add'),
  validateAdd,
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
  resolveOrganisation(ANY_ORGANISATION),
  requireCan('member.remove'),
  validate(teamValidation.removeMember),
  teamController.removeMember,
);

export default router;
