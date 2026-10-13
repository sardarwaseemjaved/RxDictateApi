import type { Response } from 'express';
import type { SuccessBody } from '../shared/response';

/**
 * Every success body is `{ data, meta }`. Keeping the envelope in one function
 * means a route cannot accidentally answer in a different shape.
 */
export const sendData = <T>(res: Response, data: T, meta?: Record<string, unknown>, statusCode = 200): void => {
  const body: SuccessBody<T> = meta === undefined ? { data } : { data, meta };
  res.status(statusCode).send(body);
};

export const sendCreated = <T>(res: Response, data: T, meta?: Record<string, unknown>): void =>
  sendData(res, data, meta, 201);
