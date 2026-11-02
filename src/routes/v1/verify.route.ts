import express from 'express';
import { verifyController } from '../../controllers';
import { verifyLimiter } from '../../middlewares/rateLimiter';

const router = express.Router();

/**
 * Checking a printout from its QR code. Public on purpose: no requireAuth and
 * no tenancy, because whoever scans the paper has no account here and the code
 * alone names the prescription. The tight per-IP limit is what stands between
 * these routes and somebody trying codes in bulk.
 */
router.get('/:code', verifyLimiter, verifyController.getVerification);

router.get('/:code/qr.svg', verifyLimiter, verifyController.getQr);

export default router;
