import morgan from 'morgan';
import type { Request, Response } from 'express';
import config from './config';
import logger from './logger';

/**
 * A prescription's verification code is the credential for its public page,
 * so a log line keeps only its first four characters: enough to tell two
 * requests apart, not enough to open either. Applied to the URL and to the
 * error message, which can repeat the path.
 */
export const redactVerifyCodes = (text: string): string =>
  text.replace(/(\/verify\/[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1…');

morgan.token('message', (_req: Request, res: Response) => redactVerifyCodes(res.locals.errorMessage || ''));
morgan.token('id', (req: Request) => req.id ?? '-');
morgan.token('path', (req: Request) => redactVerifyCodes(req.originalUrl || req.url));

const getIpFormat = () => (config.isProduction ? ':remote-addr - ' : '');
const successResponseFormat = `${getIpFormat()}[:id] :method :path :status - :response-time ms`;
const errorResponseFormat = `${getIpFormat()}[:id] :method :path :status - :response-time ms - message: :message`;

export const successHandler = morgan(successResponseFormat, {
  skip: (_req, res) => res.statusCode >= 400,
  stream: { write: (message: string) => logger.info(message.trim()) },
});

export const errorHandler = morgan(errorResponseFormat, {
  skip: (_req, res) => res.statusCode < 400,
  stream: { write: (message: string) => logger.error(message.trim()) },
});

export default { successHandler, errorHandler };
