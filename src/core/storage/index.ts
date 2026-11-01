import fs from 'fs/promises';
import path from 'path';
import { createHmac, timingSafeEqual } from 'crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import type { Types } from 'mongoose';
import config from '../../config/config';
import logger from '../../config/logger';
import { AppError } from '../errors';
import type { SignedUrlView } from '../../shared/voice.schema';

/**
 * Private file storage for dictation audio and prescription PDFs.
 *
 * Nothing here is public. A file is handed to the app as a signed URL that
 * expires in minutes, and an object key is built from ids only: a patient's
 * name must not appear in a key any more than it appears in a log line.
 */
export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Read the bytes back. Needed to retry a transcription without re-uploading. */
  get(key: string): Promise<Buffer>;
  /**
   * A URL the client can PUT straight to, so a phone photo never passes
   * through the API's request handlers. `size` is the most the upload may be;
   * the local driver enforces it, and S3 leaves it to the bucket.
   */
  signedPutUrl?(key: string, contentType: string, expiresInSeconds: number, size?: number): Promise<string>;
  signedGetUrl(key: string, expiresInSeconds: number): Promise<string>;
  remove(key: string): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

export const audioKey = (
  practiceId: Types.ObjectId | string,
  locationId: Types.ObjectId | string,
  prescriptionId: Types.ObjectId | string,
  seq: number,
  extension: string,
): string => `${practiceId}/${locationId}/${prescriptionId}/${seq}.${extension}`;

export const prescriptionPdfKey = (
  practiceId: Types.ObjectId | string,
  prescriptionId: Types.ObjectId | string,
  version: number,
  extension: string,
): string => `${practiceId}/rx/${prescriptionId}-v${version}.${extension}`;

/**
 * A preview is keyed by the version and the moment the draft last changed, so
 * asking twice for an unchanged draft overwrites the same object and a changed
 * one gets a new URL. Kept apart from the approved file, which must never be
 * written by a preview.
 */
export const prescriptionPreviewKey = (
  practiceId: Types.ObjectId | string,
  prescriptionId: Types.ObjectId | string,
  version: number,
  stamp: number,
  extension: string,
): string => `${practiceId}/rx/preview/${prescriptionId}-v${version}-${stamp}.${extension}`;

export const reportKey = (
  practiceId: Types.ObjectId | string,
  patientId: Types.ObjectId | string,
  filename: string,
): string => `${practiceId}/reports/${patientId}/${filename}`;

/**
 * Where one uploaded page lands before it belongs to a report.
 *
 * Keyed by practice and a random id, and never by patient: the app asks for
 * the URL before the report exists, and a key is not the place to record who a
 * document is about.
 */
export const reportPageKey = (practiceId: Types.ObjectId | string, pageId: string, extension: string): string =>
  `${practiceId}/reports/pages/${pageId}.${extension}`;

/** The file extension for an uploaded report page. */
export const reportExtensionFor = (contentType: string): string =>
  ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' })[contentType] ?? 'bin';

/**
 * What is actually stored under a key, worked out from its extension.
 *
 * The one place that decides, so the Content-Type a local download is served
 * with and the contentType the app is told about cannot disagree - and so an
 * app that is about to share a file on WhatsApp can find out whether it has a
 * PDF or an HTML page before it tries.
 */
export const contentTypeFor = (key: string): string => {
  const extension = key.split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      pdf: 'application/pdf',
      html: 'text/html; charset=utf-8',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      wav: 'audio/wav',
      webm: 'audio/webm',
      mp3: 'audio/mpeg',
    }[extension] ?? 'application/octet-stream'
  );
};

/** The file extension for an upload's content type. */
export const extensionFor = (contentType: string): string =>
  ({
    'audio/m4a': 'm4a',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
    'audio/mpeg': 'mp3',
  })[contentType] ?? 'bin';

/* ------------------------------------------------------------------ *
 * Signing a local download or upload
 * ------------------------------------------------------------------ */

/** Where the local driver's download and upload route is mounted. */
export const LOCAL_FILES_PATH = '/api/v1/files';

/**
 * S3 presigns its own URLs. The local driver has to do the same job itself, or
 * a dev box hands the app a path on the server's disk that a phone cannot
 * open.
 *
 * Keyed on the JWT secret, which is already the thing this server's word is
 * worth: a link is good for the key and the expiry it was signed with, and for
 * nothing else. It carries no session, so the app can hand it to a WebView, an
 * image tag or a share sheet without passing a bearer token around.
 */
const signatureFor = (key: string, expires: number): string =>
  createHmac('sha256', config.jwt.secret).update(`${key}:${expires}`).digest('hex');

/**
 * An upload is signed over everything that makes it safe to accept: which
 * object, until when, of what type and how big. The newlines and the leading
 * PUT keep it from ever matching a download's `key:expires`, so a link to read
 * a file can never be turned into a link to write one.
 */
const uploadSignatureFor = (key: string, expires: number, contentType: string, size: number): string =>
  createHmac('sha256', config.jwt.secret).update(`PUT\n${key}\n${expires}\n${contentType}\n${size}`).digest('hex');

/**
 * An expired link and a tampered one are both refused, and deliberately with
 * the same answer, because telling them apart tells a guesser which half to
 * keep trying.
 */
const refusedLink = (): AppError => new AppError('FORBIDDEN', 'That link is not valid any more.');

/** The expiry as a number, or a refusal when it is missing, malformed or past. */
const unexpired = (expires: string | undefined): number => {
  const expiresAt = Number(expires);
  if (!expires || !Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) {
    throw refusedLink();
  }
  return expiresAt;
};

/** Constant time, so the comparison itself does not leak the signature. */
const assertSignature = (signature: string | undefined, expected: string): void => {
  if (!signature) {
    throw refusedLink();
  }
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw refusedLink();
  }
};

export interface LocalDownloadRequest {
  key: string;
  expires: string | undefined;
  signature: string | undefined;
}

/** Check a local download link. Returns the content type to serve it with, or throws. */
export const verifyLocalDownload = ({ key, expires, signature }: LocalDownloadRequest): { contentType: string } => {
  const expiresAt = unexpired(expires);
  assertSignature(signature, signatureFor(key, expiresAt));
  return { contentType: contentTypeFor(key) };
};

export interface LocalUploadRequest extends LocalDownloadRequest {
  /** The `ct` the link was signed with, not the header the client sent. */
  contentType: string | undefined;
  size: string | undefined;
}

/**
 * Check a local upload link. Returns what it was signed for - the content type
 * the body has to arrive as and the most it may weigh - or throws.
 *
 * Checking the request against those is the route's job, because the route is
 * what can see the headers and the body.
 */
export const verifyLocalUpload = ({
  key,
  expires,
  signature,
  contentType,
  size,
}: LocalUploadRequest): { contentType: string; size: number } => {
  const expiresAt = unexpired(expires);
  const maxBytes = Number(size);
  if (!contentType || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw refusedLink();
  }
  assertSignature(signature, uploadSignatureFor(key, expiresAt, contentType, maxBytes));
  return { contentType, size: maxBytes };
};

/* ------------------------------------------------------------------ *
 * Drivers
 * ------------------------------------------------------------------ */

const s3Driver = (): StorageDriver => {
  const { bucket, region, endpoint, accessKeyId, secretAccessKey, forcePathStyle } = config.storage;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new AppError('STORAGE_UNAVAILABLE', 'S3 storage is selected but not configured', undefined, false);
  }

  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle } : {}),
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    name: 's3',
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async get(key) {
      const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!object.Body) {
        throw new AppError('NOT_FOUND', 'that file is no longer stored');
      }
      return Buffer.from(await object.Body.transformToByteArray());
    },
    async signedGetUrl(key, expiresInSeconds) {
      return presign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
    async signedPutUrl(key, contentType, expiresInSeconds) {
      return presign(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), {
        expiresIn: expiresInSeconds,
      });
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
};

/**
 * For a dev box and the test suite. Files land under STORAGE_LOCAL_DIR, and
 * this API stands in for the bucket: it signs its own download and upload
 * links with an HMAC and serves both at /api/v1/files, so the apps upload and
 * read a report the same way they would against S3.
 */
const localDriver = (): StorageDriver => {
  const root = path.resolve(config.storage.localDir);

  const resolveKey = (key: string): string => {
    const target = path.resolve(root, key);
    // A key comes from our own helpers, but it is still worth refusing one that
    // climbs out of the storage root.
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new AppError('VALIDATION_ERROR', 'invalid storage key');
    }
    return target;
  };

  return {
    name: 'local',
    async put(key, body) {
      const target = resolveKey(key);
      // The path is not a literal, which is the point of resolveKey above: it
      // refuses anything that escapes the storage root.
      /* eslint-disable security/detect-non-literal-fs-filename */
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
      /* eslint-enable security/detect-non-literal-fs-filename */
    },
    async get(key) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      return fs.readFile(resolveKey(key));
    },
    async signedGetUrl(key, expiresInSeconds) {
      // Prove the file is there before handing out a link to it, so a missing
      // object is a 404 now rather than a broken link later.
      resolveKey(key);
      const expires = Math.floor((Date.now() + expiresInSeconds * 1000) / 1000);
      const query = new URLSearchParams({ expires: String(expires), sig: signatureFor(key, expires) });
      return `${config.publicApiUrl}${LOCAL_FILES_PATH}/${key}?${query.toString()}`;
    },
    // A caller that names no size gets the largest upload this server takes
    // anywhere, rather than no ceiling at all.
    async signedPutUrl(key, contentType, expiresInSeconds, size = config.storage.maxAudioBytes) {
      resolveKey(key);
      const expires = Math.floor((Date.now() + expiresInSeconds * 1000) / 1000);
      const query = new URLSearchParams({
        expires: String(expires),
        ct: contentType,
        size: String(size),
        sig: uploadSignatureFor(key, expires, contentType, size),
      });
      return `${config.publicApiUrl}${LOCAL_FILES_PATH}/${key}?${query.toString()}`;
    },
    async remove(key) {
      await fs.rm(resolveKey(key), { force: true });
    },
  };
};

let cached: StorageDriver | undefined;

export const driver = (): StorageDriver => {
  if (!cached) {
    cached = config.storage.driver === 's3' ? s3Driver() : localDriver();
    logger.info(`storage driver: ${cached.name}`);
  }
  return cached;
};

export const put = async (key: string, body: Buffer, contentType: string): Promise<void> =>
  driver().put(key, body, contentType);

export const get = async (key: string): Promise<Buffer> => driver().get(key);

/**
 * A presigned PUT, or STORAGE_UNAVAILABLE when the configured driver cannot
 * issue one. Both drivers can today; the check stays for the next one.
 */
export const signedPutUrl = async (
  key: string,
  contentType: string,
  { size, expiresInSeconds = config.storage.signedUrlTtlSeconds }: { size?: number; expiresInSeconds?: number } = {},
): Promise<{ url: string; expiresAt: Date }> => {
  const active = driver();
  if (!active.signedPutUrl) {
    throw new AppError(
      'STORAGE_UNAVAILABLE',
      `Uploads need object storage. This server is running the "${active.name}" driver; set STORAGE_DRIVER=s3.`,
    );
  }
  return {
    url: await active.signedPutUrl(key, contentType, expiresInSeconds, size),
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
  };
};

/** Whether this server can hand out upload URLs at all. */
export const supportsUploads = (): boolean => driver().signedPutUrl !== undefined;

export const signedGetUrl = async (
  key: string,
  expiresInSeconds: number = config.storage.signedUrlTtlSeconds,
): Promise<SignedUrlView> => ({
  url: await driver().signedGetUrl(key, expiresInSeconds),
  expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
  contentType: contentTypeFor(key),
});

/** Used by the audio retention sweep. A key that is already gone is not an error. */
export const remove = async (key: string): Promise<void> => {
  try {
    await driver().remove(key);
  } catch (error) {
    logger.warn(`could not delete ${key}: ${(error as Error).message}`);
  }
};

export default {
  driver,
  put,
  get,
  signedGetUrl,
  signedPutUrl,
  verifyLocalDownload,
  verifyLocalUpload,
  contentTypeFor,
  supportsUploads,
  remove,
  audioKey,
  prescriptionPdfKey,
  prescriptionPreviewKey,
  reportKey,
  reportPageKey,
  extensionFor,
  reportExtensionFor,
};
