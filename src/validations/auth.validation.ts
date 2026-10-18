import {
  logoutAllBodySchema,
  logoutBodySchema,
  refreshBodySchema,
  sendOtpBodySchema,
  verifyOtpBodySchema,
} from '../shared/auth.schema';

/**
 * Request wiring only. The schemas themselves live in src/shared, which the app
 * imports too; these modules exist so a route reads
 * `validate(authValidation.sendOtp)` and nothing in the express layer has to
 * know how a contract is put together.
 */
export const sendOtp = { body: sendOtpBodySchema };
export const verifyOtp = { body: verifyOtpBodySchema };
export const refresh = { body: refreshBodySchema };
export const logout = { body: logoutBodySchema };
export const logoutAll = { body: logoutAllBodySchema };
