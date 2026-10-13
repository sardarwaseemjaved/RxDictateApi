import mongoose from 'mongoose';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import type { ErrorRequestHandler } from 'express';
import config from '../config/config';
import logger from '../config/logger';
import { AppError, isAppError } from '../core/errors';
import type { ErrorBody } from '../shared/response';

/**
 * Turn whatever was thrown into an AppError, so the handler below only ever
 * deals with one kind of thing.
 *
 * Errors raised by a library are mapped onto a code the app already knows:
 * a duplicate key is a CONFLICT, a bad ObjectId is a VALIDATION_ERROR, an
 * expired token is TOKEN_INVALID. Anything unrecognised is a bug, and is
 * marked non-operational so its message is not shown to the caller.
 */
export const errorConverter: ErrorRequestHandler = (err, req, res, next) => {
  if (isAppError(err)) {
    return next(err);
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((issue) => ({ field: issue.path, message: issue.message }));
    return next(new AppError('VALIDATION_ERROR', err.message, details));
  }

  if (err instanceof mongoose.Error.CastError) {
    return next(new AppError('VALIDATION_ERROR', `${err.path} is not a valid ${err.kind}`));
  }

  if (err && (err as { code?: number }).code === 11000) {
    return next(new AppError('CONFLICT', 'That record already exists'));
  }

  if (err instanceof TokenExpiredError || err instanceof JsonWebTokenError) {
    return next(new AppError('TOKEN_INVALID', 'Please authenticate'));
  }

  if (err instanceof mongoose.Error) {
    return next(new AppError('VALIDATION_ERROR', err.message, undefined, false));
  }

  const message = err instanceof Error ? err.message : 'Something went wrong';
  const converted = new AppError('INTERNAL', message, undefined, false);
  if (err instanceof Error && err.stack) {
    converted.stack = err.stack;
  }
  return next(converted);
};

/** The only place a non-2xx body is written. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const error: AppError = isAppError(err) ? err : new AppError('INTERNAL', 'Something went wrong', undefined, false);

  let { statusCode } = error;
  let { message } = error;
  let { code } = error;

  // A bug's message can carry internals, so production sees a flat 500.
  if (config.isProduction && !error.isOperational) {
    statusCode = 500;
    code = 'INTERNAL';
    message = 'Something went wrong';
  }

  // Picked up by the access log, which is where the detail belongs.
  res.locals.errorMessage = error.message;

  const body: ErrorBody & { error: { stack?: string } } = {
    error: {
      code,
      message,
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(config.env === 'development' ? { stack: error.stack } : {}),
    },
  };

  if (!error.isOperational) {
    logger.error(`[${req.id ?? '-'}] ${error.stack ?? error.message}`);
  } else if (config.env === 'development') {
    logger.debug(`[${req.id ?? '-'}] ${code}: ${error.message}`);
  }

  res.status(statusCode).send(body);
};

export default { errorConverter, errorHandler };
