import express from 'express';
import helmet from 'helmet';
import xss from 'xss-clean';
import mongoSanitize from 'express-mongo-sanitize';
import compression from 'compression';
import cors, { type CorsOptions } from 'cors';
import config from './config/config';
import morgan from './config/morgan';
import requestId from './middlewares/requestId';
import { generalLimiter } from './middlewares/rateLimiter';
import routes from './routes/v1';
import { errorConverter, errorHandler } from './middlewares/error';
import { AppError } from './core/errors';
// Registers the event handlers. Imported for the side effect, on purpose.
import './listeners';

const app = express();

/**
 * The request pipeline, in the order it runs:
 *
 *   requestId -> logger -> rateLimit -> [per route] requireAuth ->
 *   resolvePractice -> resolveLocation -> can(action) -> validate(schema) ->
 *   handler -> errorHandler
 *
 * The first three are here because they apply to everything, including a 404.
 * The rest are declared on each route, so reading a route file tells you
 * exactly who may call it and with what.
 */
app.use(requestId);

if (!config.isTest) {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// set security HTTP headers
app.use(helmet());

/**
 * Dictation audio arrives base64 encoded inside the JSON body, which inflates
 * it by about a third, so the ceiling is derived from the audio limit rather
 * than guessed at.
 */
const jsonLimit = Math.max(1024 * 1024, Math.ceil(config.storage.maxAudioBytes * 1.4));
app.use(express.json({ limit: jsonLimit }));
app.use(express.urlencoded({ extended: true, limit: jsonLimit }));

// sanitize request data
app.use(xss());
app.use(mongoSanitize());

// gzip compression
app.use(compression());

/**
 * CORS used to be wide open. It is now an allow-list.
 *
 * A request with no Origin header is allowed through: that is the React Native
 * app, which is not a browser and sends none. Browsers always send one, so the
 * check still does its job where it matters.
 */
const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || config.cors.origins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new AppError('FORBIDDEN', 'Origin not allowed'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Practice-Id', 'X-Location-Id', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Always on, in every environment.
app.use(generalLimiter);

app.use('/api/v1', routes);

// send back a 404 for any unknown api request
app.use((req, res, next) => {
  next(new AppError('NOT_FOUND', `${req.method} ${req.path} is not a route on this API`));
});

app.use(errorConverter);
app.use(errorHandler);

export default app;
