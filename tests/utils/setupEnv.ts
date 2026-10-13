/**
 * Runs before anything imports src/config/config, which validates process.env
 * and throws when something required is missing. A test run must not depend on
 * a developer's .env file, so the required vars get defaults here.
 */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URL = process.env.MONGODB_URL ?? 'mongodb://127.0.0.1:27017/clinic-api';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'a-test-secret-that-is-long-enough';
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? 'http://localhost:8081';

// The IP-keyed buckets would otherwise fire part way through a suite, since
// every request in a test run comes from the same address. The per-phone OTP
// cooldown in the auth service is the behaviour the tests actually check.
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX ?? '100000';
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX ?? '100000';
process.env.OTP_RATE_LIMIT_MAX = process.env.OTP_RATE_LIMIT_MAX ?? '100000';

process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER ?? 'local';
process.env.STORAGE_LOCAL_DIR = process.env.STORAGE_LOCAL_DIR ?? '.storage/test';

// The deterministic drivers, so the dictation path - ordering, validation,
// apply, audit - is exercised end to end without a real provider.
process.env.STT_PROVIDER = process.env.STT_PROVIDER ?? 'mock';
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER ?? 'mock';
