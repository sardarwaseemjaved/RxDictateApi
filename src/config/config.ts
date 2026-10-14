import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ path: path.join(__dirname, '../../.env') });

/**
 * `z.coerce.boolean()` would read the string "false" as true, which is the
 * wrong answer for every env var, so booleans go through this instead.
 */
const booleanish = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      return value === 'true' || value === '1';
    });

const csv = () =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );

const envSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  MONGODB_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRATION_MINUTES: z.coerce.number().int().min(1).default(30),
  JWT_REFRESH_EXPIRATION_DAYS: z.coerce.number().int().min(1).default(30),

  OTP_EXPIRATION_MINUTES: z.coerce.number().int().min(1).default(10),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  /** Seconds a phone must wait before another code is sent to it. */
  OTP_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
  OTP_LOG_IN_DEV: booleanish(true),
  /** A fixed sign-in code for testing a client. Six digits, or empty for random. */
  OTP_FIXED_CODE: z
    .string()
    .regex(/^\d{6}$/, 'must be six digits')
    .or(z.literal(''))
    .optional()
    .transform((value) => (value === '' ? undefined : value)),

  /** Comma separated list of origins the app and the web portal are served from. */
  CORS_ORIGINS: csv(),

  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(5),

  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish(true),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  MAX_AUDIO_UPLOAD_MB: z.coerce.number().min(0.1).max(100).default(20),

  SMS_PROVIDER: z.enum(['log']).default('log'),
  SMS_SENDER_ID: z.string().default('Clinic'),

  /** Speech to text and the ops extractor. `none` fails a segment with a clear error. */
  STT_PROVIDER: z.enum(['none', 'mock']).default('none'),
  LLM_PROVIDER: z.enum(['none', 'mock']).default('none'),
  /** A segment that has not finished in this long is marked failed so the queue moves on. */
  VOICE_SEGMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(90_000),

  /** An HTML-to-PDF service. Without one, the print file is stored as HTML. */
  PDF_RENDERER_URL: z.string().optional(),

  AUDIO_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
  throw new Error(`Config validation error: ${details}`);
}

const env = parsed.data;

/**
 * In production an empty allow-list would mean "no browser may call this API",
 * which is a deployment mistake worth failing the boot over rather than a
 * default worth guessing at.
 */
if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
  throw new Error('Config validation error: CORS_ORIGINS must list at least one origin in production');
}

const defaultDevOrigins = ['http://localhost:3000', 'http://localhost:8081', 'http://localhost:19006'];

const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  /** Surfaced in the OpenAPI document; set by the package manager when it runs a script. */
  version: process.env.npm_package_version ?? '1.0.0',
  mongoose: {
    url: env.MONGODB_URL + (env.NODE_ENV === 'test' ? '-test' : ''),
  },
  jwt: {
    secret: env.JWT_SECRET,
    accessExpirationMinutes: env.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: env.JWT_REFRESH_EXPIRATION_DAYS,
  },
  otp: {
    expirationMinutes: env.OTP_EXPIRATION_MINUTES,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    cooldownSeconds: env.OTP_COOLDOWN_SECONDS,
    /**
     * Outside development and test this stays false whatever the env var says,
     * so a code is never handed back to the caller in production.
     */
    exposeInResponse: env.NODE_ENV !== 'production' && env.OTP_LOG_IN_DEV,
    /**
     * The same code for every sign-in, so a client can be tested without an SMS
     * gateway and without reading a code out of a response.
     *
     * Forced to undefined in production whatever the environment says. With this
     * set, anybody who knows a phone number can sign in as its owner - it is a
     * complete bypass of authentication, not a convenience. Ignoring it is
     * deliberate rather than fatal: a stray variable on a deployment should not
     * take the API down, and silently falling back to random codes is the safe
     * direction to fail in.
     */
    fixedCode: env.NODE_ENV === 'production' ? undefined : env.OTP_FIXED_CODE,
  },
  cors: {
    origins: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : defaultDevOrigins,
  },
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MINUTES * 60 * 1000,
    max: env.RATE_LIMIT_MAX,
    authMax: env.AUTH_RATE_LIMIT_MAX,
    otpMax: env.OTP_RATE_LIMIT_MAX,
  },
  storage: {
    driver: env.STORAGE_DRIVER,
    localDir: env.STORAGE_LOCAL_DIR,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
    maxAudioBytes: Math.round(env.MAX_AUDIO_UPLOAD_MB * 1024 * 1024),
  },
  sms: {
    provider: env.SMS_PROVIDER,
    senderId: env.SMS_SENDER_ID,
  },
  voice: {
    sttProvider: env.STT_PROVIDER,
    llmProvider: env.LLM_PROVIDER,
    segmentTimeoutMs: env.VOICE_SEGMENT_TIMEOUT_MS,
  },
  pdf: {
    rendererUrl: env.PDF_RENDERER_URL,
  },
  practiceDefaults: {
    audioRetentionDays: env.AUDIO_RETENTION_DAYS,
  },
};

export type Config = typeof config;
export default config;
