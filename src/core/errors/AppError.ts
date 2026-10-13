import { ERROR_STATUS, type ErrorCode } from '../../shared/errorCodes';

/**
 * Every error this API raises on purpose.
 *
 * The code is the contract with the app and decides the HTTP status; the
 * message is for a human to read. `isOperational` marks the errors we expect
 * and are happy to describe to the caller, as opposed to a bug, whose message
 * is swallowed in production.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly isOperational: boolean;

  constructor(code: ErrorCode, message?: string, details?: unknown, isOperational = true) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = ERROR_STATUS[code];
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }

  static notFound(what: string): AppError {
    return new AppError('NOT_FOUND', `${what} not found`);
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;
