import type { ErrorCode } from './errorCodes';

/** Every 2xx body. `meta` carries paging and anything else that is not the payload. */
export interface SuccessBody<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Every non-2xx body. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

export interface PageMeta extends Record<string, unknown> {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
