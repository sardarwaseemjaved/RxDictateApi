import winston from 'winston';
import config from './config';

const enumerateErrorFormat = winston.format((info) => {
  if (info instanceof Error) {
    Object.assign(info, { message: info.stack });
  }
  return info;
});

/**
 * Application logging. Nothing written here may contain a patient's name, phone
 * number or any other identifying detail: ids only. The audit log is where the
 * before/after of a clinical record belongs.
 */
const logger = winston.createLogger({
  level: config.env === 'development' ? 'debug' : 'info',
  silent: config.isTest,
  format: winston.format.combine(
    enumerateErrorFormat(),
    config.env === 'development' ? winston.format.colorize() : winston.format.uncolorize(),
    winston.format.splat(),
    winston.format.printf(({ level, message }) => `${level}: ${message}`),
  ),
  transports: [
    new winston.transports.Console({
      stderrLevels: ['error'],
    }),
  ],
});

export default logger;
