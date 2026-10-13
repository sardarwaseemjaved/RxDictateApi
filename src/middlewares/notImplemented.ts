import type { RequestHandler } from 'express';
import { AppError } from '../core/errors';

/**
 * A route that exists, is spelled the way it always will be, and is honest
 * about not being built yet.
 *
 * The app can link to it today and nothing gets renamed when it goes live. It
 * still sits behind the real auth, tenancy and permission middleware, so the
 * 501 it answers with is the answer for a caller who is allowed to ask.
 */
const notImplemented =
  (what: string): RequestHandler =>
  (_req, _res, next) => {
    next(new AppError('NOT_IMPLEMENTED', `${what} is not available yet`));
  };

export default notImplemented;
