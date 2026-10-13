import type { Request } from 'express';

/**
 * After `validate(schema)` has run, req.query, req.params and req.body hold the
 * value zod parsed - coerced, defaulted and with unknown keys stripped - and
 * not what express put there. These three say so in one place rather than
 * leaving a cast at every call site.
 */
export const parsedQuery = <T>(req: Request): T => req.query as unknown as T;

export const parsedParams = <T>(req: Request): T => req.params as unknown as T;

export const parsedBody = <T>(req: Request): T => req.body as T;
