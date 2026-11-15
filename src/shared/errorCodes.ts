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
  'LAST_ADMIN',

  // Organisations
  'ORGANISATION_SUSPENDED',

  // The review queue
  'SUBMISSION_WRONG_STATUS',

  // Announcements
  'ANNOUNCEMENT_WRONG_STATUS',
  'ANNOUNCEMENT_WITHDRAWN',
  'ANNOUNCEMENT_ENDED',
  'ANNOUNCEMENT_NOT_AN_EVENT',
  'ANNOUNCEMENT_ALLOWANCE_USED',
  'ANNOUNCEMENT_REACH_OVER_ALLOWANCE',

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

  // The patient's area
  'PORTAL_LINK_FAILED',
  'PORTAL_LINK_UNAVAILABLE',
  'PORTAL_INVITE_TOO_SOON',

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
  /** A company or the platform would be left with no admin. Remove another, or add one first. */
  LAST_ADMIN: 409,

  /** The caller's company is suspended by RxDictate, or a reviewer acted on a suspended company's submission. */
  ORGANISATION_SUSPENDED: 403,

  /** The submission is not in a state that allows this: approving a withdrawn one, editing a pending one. `details.status` says which. */
  SUBMISSION_WRONG_STATUS: 409,

  /** The announcement is not in a state that allows this: publishing a withdrawn one, withdrawing a draft. `details.status` says which. */
  ANNOUNCEMENT_WRONG_STATUS: 409,
  /** RxDictate withdrew it: no reminder or registration any more. */
  ANNOUNCEMENT_WITHDRAWN: 409,
  /** Its window has passed, or for a reminder or a registration, the event has already started. */
  ANNOUNCEMENT_ENDED: 409,
  /** A reminder or a registration on something that is not a seminar or an event. */
  ANNOUNCEMENT_NOT_AN_EVENT: 409,
  /**
   * The sponsor has published all the posts its allowance gives it this month
   * (Asia/Karachi). `details: { used, allowed, month }`, month as `YYYY-MM`.
   */
  ANNOUNCEMENT_ALLOWANCE_USED: 409,
  /**
   * The audience reaches more people than the sponsor's allowance lets one
   * post reach. `details: { reach, allowed }`; narrow the audience.
   */
  ANNOUNCEMENT_REACH_OVER_ALLOWANCE: 409,

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

  /** One answer for every reason a record can't be linked, so none of them says whether it exists. */
  PORTAL_LINK_FAILED: 400,
  /** The caller's own link, which is dormant or whose clinic has the portal off. GET /portal/links says which. */
  PORTAL_LINK_UNAVAILABLE: 403,
  /** One invite per record per day. `details.retryAt` says when. */
  PORTAL_INVITE_TOO_SOON: 429,

  FEATURE_DISABLED: 403,
  STORAGE_UNAVAILABLE: 503,
};
