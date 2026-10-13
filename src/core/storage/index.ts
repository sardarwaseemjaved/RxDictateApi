import fs from 'fs/promises';
import path from 'path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import type { Types } from 'mongoose';
import config from '../../config/config';
import logger from '../../config/logger';
import { AppError } from '../errors';

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

export const reportKey = (
  practiceId: Types.ObjectId | string,
  patientId: Types.ObjectId | string,
  filename: string,
): string => `${practiceId}/reports/${patientId}/${filename}`;

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
    async signedGetUrl(key, expiresInSeconds) {
      return presign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
};

/**
 * For a dev box and the test suite. Files land under STORAGE_LOCAL_DIR and a
 * "signed" URL is the absolute path, which is honest: there is no signing here
 * and there is nothing to sign against. The driver name travels in the response
 * meta so the app can tell the difference.
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
    async signedGetUrl(key) {
      return `file://${resolveKey(key)}`;
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

export const signedGetUrl = async (
  key: string,
  expiresInSeconds: number = config.storage.signedUrlTtlSeconds,
): Promise<{ url: string; expiresAt: Date }> => ({
  url: await driver().signedGetUrl(key, expiresInSeconds),
  expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
});

/** Used by the audio retention sweep. A key that is already gone is not an error. */
export const remove = async (key: string): Promise<void> => {
  try {
    await driver().remove(key);
  } catch (error) {
    logger.warn(`could not delete ${key}: ${(error as Error).message}`);
  }
};

export default { driver, put, signedGetUrl, remove, audioKey, prescriptionPdfKey, reportKey, extensionFor };
