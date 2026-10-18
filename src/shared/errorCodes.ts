/**
 * Every error this API can return, as a fixed enum.
 *
 * The app switches on `error.code`, never on the message or the HTTP status, so
 * a code is a contract: once the app ships against one it may not be renamed.
 * Messages are free to change and are meant to be shown to a human.
 */
export const ERROR_CODES = [
  // Generic
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'NOT_IMPLEMENTED',
  'INTERNAL',

  // Auth
  'PHONE_INVALID',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_LOCKED',
  'OTP_COOLDOWN',
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
  'SESSION_REVOKED',
  'SESSION_EXPIRED',

  // Tenancy
  'PRACTICE_REQUIRED',
  'NOT_MEMBER',
  'MEMBERSHIP_REMOVED',
  'LOCATION_REQUIRED',
  'LOCATION_NOT_ALLOWED',
  'LOCATION_ARCHIVED',

  // Team
  'LAST_DOCTOR',
  'ALREADY_MEMBER',

  // Prescriptions
  'RX_LOCKED',
  'RX_NOT_DRAFT',
  'RX_ALREADY_SUPERSEDED',
  'RX_NOT_APPROVED',
  'RX_HAS_FLAGS',
  'OP_INVALID',

  // Voice
  'SEGMENT_OUT_OF_ORDER',
  'SEGMENT_DUPLICATE',
  'VOICE_SESSION_CLOSED',
  'VOICE_SEGMENT_BUSY',
  'TRANSCRIPTION_FAILED',

  // Capability
  'FEATURE_DISABLED',
  'STORAGE_UNAVAILABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The HTTP status each code answers with. Kept here rather than in the error
 * class so the app can reason about a code without a round trip, and so a new
 * code cannot be added without deciding its status.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,

  PHONE_INVALID: 400,
  OTP_INVALID: 401,
  OTP_EXPIRED: 401,
  OTP_LOCKED: 429,
  OTP_COOLDOWN: 429,
  TOKEN_INVALID: 401,
  /** The access token is past its expiry. The app refreshes and retries. */
  TOKEN_EXPIRED: 401,
  /** Logged out, a rotated token reused, or the session is gone. Sign out locally. */
  SESSION_REVOKED: 401,
  /** The refresh token is past the session's expiry. Sign out locally. */
  SESSION_EXPIRED: 401,

  PRACTICE_REQUIRED: 400,
  NOT_MEMBER: 403,
  /** Was a member of this practice and was removed, as against never a member. */
  MEMBERSHIP_REMOVED: 403,
  LOCATION_REQUIRED: 400,
  LOCATION_NOT_ALLOWED: 403,
  LOCATION_ARCHIVED: 409,

  LAST_DOCTOR: 409,
  ALREADY_MEMBER: 409,

  RX_LOCKED: 409,
  RX_NOT_DRAFT: 409,
  RX_ALREADY_SUPERSEDED: 409,
  RX_NOT_APPROVED: 409,
  RX_HAS_FLAGS: 409,
  OP_INVALID: 400,

  SEGMENT_OUT_OF_ORDER: 409,
  SEGMENT_DUPLICATE: 409,
  VOICE_SESSION_CLOSED: 409,
  VOICE_SEGMENT_BUSY: 409,
  TRANSCRIPTION_FAILED: 422,

  FEATURE_DISABLED: 403,
  STORAGE_UNAVAILABLE: 503,
};
