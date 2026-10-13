import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Hand a rejected promise to the error handler instead of losing it. */
const catchAsync =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => next(err));
  };

export default catchAsync;
