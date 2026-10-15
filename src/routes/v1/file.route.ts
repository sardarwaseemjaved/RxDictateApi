import express from 'express';
import { get as getObject, verifyLocalDownload } from '../../core/storage';
import config from '../../config/config';
import { AppError } from '../../core/errors';
import catchAsync from '../../utils/catchAsync';

const router = express.Router();

/**
 * Serve a file the local storage driver is holding.
 *
 * Mounted only when that driver is in use. With S3 or R2 the bucket serves its
 * own presigned URLs and this route does not exist, which is the arrangement
 * in production.
 *
 * Deliberately without requireAuth: the link is the credential. It is HMAC
 * signed with the key and an expiry, which is what lets the app hand it to a
 * WebView, an image tag or a share sheet - none of which will attach a bearer
 * token. An expired or altered link is refused.
 */
router.get(
  '/*',
  catchAsync(async (req, res) => {
    const key = (req.params as unknown as string[])[0];
    if (!key) {
      throw new AppError('NOT_FOUND', 'No file was asked for');
    }

    const { contentType } = verifyLocalDownload({
      key,
      expires: typeof req.query.expires === 'string' ? req.query.expires : undefined,
      signature: typeof req.query.sig === 'string' ? req.query.sig : undefined,
    });

    let body: Buffer;
    try {
      body = await getObject(key);
    } catch {
      throw new AppError('NOT_FOUND', 'That file is no longer stored');
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(body.length));
    // A signed link is for one person for a few minutes; a shared cache must
    // not keep a patient's prescription.
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(body);
  }),
);

export default router;

/** Only worth mounting when this server is the one holding the files. */
export const servesLocalFiles = (): boolean => config.storage.driver === 'local';
