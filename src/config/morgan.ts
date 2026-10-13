import morgan from 'morgan';
import type { Request, Response } from 'express';
import config from './config';
import logger from './logger';

morgan.token('message', (_req: Request, res: Response) => res.locals.errorMessage || '');
morgan.token('id', (req: Request) => req.id ?? '-');

const getIpFormat = () => (config.isProduction ? ':remote-addr - ' : '');
const successResponseFormat = `${getIpFormat()}[:id] :method :url :status - :response-time ms`;
const errorResponseFormat = `${getIpFormat()}[:id] :method :url :status - :response-time ms - message: :message`;

export const successHandler = morgan(successResponseFormat, {
  skip: (_req, res) => res.statusCode >= 400,
  stream: { write: (message: string) => logger.info(message.trim()) },
});

export const errorHandler = morgan(errorResponseFormat, {
  skip: (_req, res) => res.statusCode < 400,
  stream: { write: (message: string) => logger.error(message.trim()) },
});

export default { successHandler, errorHandler };
