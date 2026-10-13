import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';

const SANE_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * First in the chain: every request gets an id, which goes into the access log
 * and comes back as `X-Request-Id`.
 *
 * An inbound id is honoured when it looks like one, so a report from the app
 * can be traced to the request that caused it. Anything else is replaced.
 */
const requestId: RequestHandler = (req, res, next) => {
  const inbound = req.get('x-request-id');
  req.id = inbound && SANE_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

export default requestId;
