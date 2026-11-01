import { createHash } from 'crypto';
import express, { type Request, type RequestHandler } from 'express';
import { get as getObject, put as putObject, verifyLocalDownload, verifyLocalUpload } from '../../core/storage';
import config from '../../config/config';
import { AppError } from '../../core/errors';
import catchAsync from '../../utils/catchAsync';
import { sendData } from '../../utils/response';

const router = express.Router();

const keyFrom = (req: Request): string => {
  const key = (req.params as unknown as string[])[0];
  if (!key) {
    throw new AppError('NOT_FOUND', 'No file was asked for');
  }
  return key;
};

const queryString = (req: Request, name: string): string | undefined =>
  typeof req.query[name] === 'string' ? (req.query[name] as string) : undefined;

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
    const key = keyFrom(req);

    const { contentType } = verifyLocalDownload({
      key,
      expires: queryString(req, 'expires'),
      signature: queryString(req, 'sig'),
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
    // helmet answers same-origin by default, which stops the web app showing a
    // report page in an <img> from its own dev server. The signature is what
    // guards this file, not the origin asking for it.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(body);
  }),
);

/**
 * Check an upload before a byte of it is read: the link, then the headers.
 *
 * Refusing on the declared Content-Length here, rather than after reading,
 * means an oversized body is turned away without being buffered. A body that
 * lies about its length is still stopped by the limit on the reader below.
 */
const checkUpload: RequestHandler = (req, res, next) => {
  try {
    const key = keyFrom(req);
    const signed = verifyLocalUpload({
      key,
      expires: queryString(req, 'expires'),
      signature: queryString(req, 'sig'),
      contentType: queryString(req, 'ct'),
      size: queryString(req, 'size'),
    });

    const sent = (req.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (sent !== signed.contentType) {
      throw new AppError(
        'VALIDATION_ERROR',
        `This upload was signed for ${signed.contentType}; send it with that Content-Type.`,
      );
    }

    const declared = Number(req.get('content-length'));
    if (Number.isFinite(declared) && declared > signed.size) {
      throw new AppError('VALIDATION_ERROR', `This upload was signed for at most ${signed.size} bytes.`);
    }

    res.locals.upload = { key, ...signed };
    next();
  } catch (error) {
    next(error);
  }
};

/** Read the body as bytes, no more than the signed size. */
const readUpload: RequestHandler = (req, res, next) => {
  const { size } = res.locals.upload as { size: number };
  express.raw({ type: () => true, limit: size })(req, res, (error?: unknown) => {
    if (!error) {
      next();
      return;
    }
    next(
      (error as { type?: string }).type === 'entity.too.large'
        ? new AppError('VALIDATION_ERROR', `This upload was signed for at most ${size} bytes.`)
        : new AppError('VALIDATION_ERROR', 'The upload did not arrive in one piece. Try again.'),
    );
  });
};

/**
 * Take a file for the local storage driver: the dev-box stand-in for a
 * presigned S3 PUT, so a report can be uploaded with no bucket configured.
 *
 * Mounted only with the local driver, like the GET above, and for the same
 * reason without requireAuth: the link is the credential. It is signed over
 * the key, the expiry, the content type and the size, so it writes one object,
 * of the kind that was asked for, and nothing bigger. An expired or altered
 * link is refused as a download link is, with FORBIDDEN.
 *
 * Answers like a bucket does - 200 and an ETag - so an app does not need to
 * know which one it uploaded to.
 */
router.put(
  '/*',
  checkUpload,
  readUpload,
  catchAsync(async (req, res) => {
    const { key, contentType } = res.locals.upload as { key: string; contentType: string };
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'The upload was empty.');
    }

    await putObject(key, body, contentType);

    // S3's ETag for a single-part upload is the MD5 of the bytes. A checksum,
    // not a security measure.
    res.setHeader('ETag', `"${createHash('md5').update(body).digest('hex')}"`);
    sendData(res, { fileKey: key, size: body.length });
  }),
);

export default router;

/** Only worth mounting when this server is the one holding the files. */
export const servesLocalFiles = (): boolean => config.storage.driver === 'local';
