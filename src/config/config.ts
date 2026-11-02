import path from 'path';
import { networkInterfaces } from 'os';
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
  /**
   * How many proxies sit in front of this process. Behind nginx every request
   * arrives from 127.0.0.1, and the rate limiters would put every client in one
   * bucket - so a deployment behind a proxy sets 1. Zero by default, because
   * trusting X-Forwarded-For with nothing in front lets a client pick its own IP.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

  MONGODB_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRATION_MINUTES: z.coerce.number().int().min(1).default(30),
  /**
   * How long a signed-in device stays signed in, and the hard ceiling that a
   * sliding expiry cannot climb past - so a phone refreshing every day cannot
   * keep one sign-in alive forever.
   */
  SESSION_EXPIRATION_DAYS: z.coerce.number().int().min(1).default(60),
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).default(90),
  /** How long "this session is live" is believed without asking the database. */
  SESSION_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(60),

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

  /**
   * Comma separated list of origins the web app and the web portal are served
   * from. Setting it replaces the dev defaults below rather than adding to them.
   */
  CORS_ORIGINS: csv(),

  RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(20),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(5),
  /** Per minute, per IP. Signing out must stay available. */
  LOGOUT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
  /** Per minute, per IP, across both public verify routes, so codes cannot be tried in bulk. */
  VERIFY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),

  /**
   * Where a printout's QR code points: the web app's public page for checking
   * a prescription, `/v` on the web app. The code is appended to it. Required
   * in production; in development it is guessed from this machine's LAN
   * address, so a phone on the same Wi-Fi can scan a test print. Blank reads
   * as unset.
   */
  VERIFY_BASE_URL: z
    .string()
    .url()
    .or(z.literal(''))
    .optional()
    .transform((value) => (value === '' ? undefined : value)),

  /**
   * The address this API is reachable at from outside, used to build download
   * links for the local storage driver. Unset, it is guessed from this
   * machine's LAN address, because a phone cannot open localhost.
   */
  PUBLIC_API_URL: z.string().url().optional(),
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
  /** What the app is called in an SMS: "Install <this> and sign in". */
  APP_NAME: z.string().min(1).max(60).default('the clinic app'),

  /** Speech to text and the ops extractor. `none` fails a segment with a clear error. */
  STT_PROVIDER: z.enum(['none', 'mock', 'openai']).default('none'),
  LLM_PROVIDER: z.enum(['none', 'mock', 'openai']).default('none'),

  /**
   * Required when either provider is openai. Never logged and never returned.
   *
   * A blank value reads as no key rather than as a validation error, so a
   * commented-out line in .env behaves the way whoever commented it out meant.
   */
  OPENAI_API_KEY: z
    .string()
    .min(1)
    .or(z.literal(''))
    .optional()
    .transform((value) => (value === '' ? undefined : value)),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  /** The model that turns a transcript into ops. */
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  /**
   * The transcription model. gpt-4o-transcribe reads code-switched Urdu and
   * English better than whisper-1 does, which is the whole job here;
   * gpt-4o-mini-transcribe is half the price if that trade is worth making.
   */
  OPENAI_STT_MODEL: z.string().min(1).default('gpt-4o-transcribe'),
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

/**
 * Every prescription approved without it would carry a QR code pointing at a
 * guess. The paper outlives any fix, so this fails the boot instead.
 */
if (env.NODE_ENV === 'production' && !env.VERIFY_BASE_URL) {
  throw new Error('Config validation error: VERIFY_BASE_URL must be set in production');
}

/**
 * Fail at boot rather than on the first recording. A doctor finding out
 * mid-consultation that dictation was never configured is worse than a server
 * that refuses to start.
 */
const usesOpenAi = env.STT_PROVIDER === 'openai' || env.LLM_PROVIDER === 'openai';
if (usesOpenAi && !env.OPENAI_API_KEY) {
  throw new Error('Config validation error: OPENAI_API_KEY is required when STT_PROVIDER or LLM_PROVIDER is openai');
}

/**
 * 5173 is the web app's dev server. It calls this API from the browser and,
 * with the local storage driver, PUTs report pages straight to /files, so it
 * is cross-origin on both counts.
 */
const defaultDevOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8081',
  'http://localhost:19006',
];

/**
 * The first non-internal IPv4 address of this machine.
 *
 * A link to localhost is useless on a phone and useless in the Android
 * emulator, and both can reach the host's LAN address, so that is the sensible
 * guess when nobody has said. PUBLIC_API_URL overrides it, which is what a
 * deployment should set.
 */
const lanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find((address) => address.family === 'IPv4' && !address.internal)?.address;

const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  trustProxy: env.TRUST_PROXY,
  /** Surfaced in the OpenAPI document; set by the package manager when it runs a script. */
  version: process.env.npm_package_version ?? '1.0.0',
  mongoose: {
    url: env.MONGODB_URL + (env.NODE_ENV === 'test' ? '-test' : ''),
  },
  jwt: {
    secret: env.JWT_SECRET,
    accessExpirationMinutes: env.JWT_ACCESS_EXPIRATION_MINUTES,
  },
  session: {
    expirationDays: env.SESSION_EXPIRATION_DAYS,
    maxDays: env.SESSION_MAX_DAYS,
    cacheSeconds: env.SESSION_CACHE_SECONDS,
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
    logoutMax: env.LOGOUT_RATE_LIMIT_MAX,
    verifyMax: env.VERIFY_RATE_LIMIT_MAX,
  },
  verify: {
    /** No trailing slash; a code is appended as `${baseUrl}/${code}`. */
    baseUrl: (env.VERIFY_BASE_URL ?? `http://${lanAddress() ?? 'localhost'}:5173/v`).replace(/\/+$/, ''),
  },
  /** Where a download link should point. */
  publicApiUrl: env.PUBLIC_API_URL ?? `http://${lanAddress() ?? 'localhost'}:${env.PORT}`,
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
    appName: env.APP_NAME,
  },
  voice: {
    sttProvider: env.STT_PROVIDER,
    llmProvider: env.LLM_PROVIDER,
    segmentTimeoutMs: env.VOICE_SEGMENT_TIMEOUT_MS,
  },
  openai: {
    /**
     * Read only by the two provider modules. It is never logged, never put in
     * a response and never written to the audit log.
     */
    apiKey: env.OPENAI_API_KEY,
    baseUrl: env.OPENAI_BASE_URL,
    model: env.OPENAI_MODEL,
    sttModel: env.OPENAI_STT_MODEL,
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
