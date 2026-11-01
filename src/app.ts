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
import logger from './config/logger';
// Registers the event handlers. Imported for the side effect, on purpose.
import './listeners';

const app = express();

// So req.ip is the client and not nginx. See TRUST_PROXY in config.
app.set('trust proxy', config.trustProxy);

/**
 * The request pipeline, in the order it runs:
 *
 *   requestId -> access logger -> voice upload ingress logger -> rateLimit ->
 *   [per route] requireAuth -> resolvePractice -> resolveLocation ->
 *   can(action) -> validate(schema) -> handler -> errorHandler
 *
 * The shared middleware is here because it applies before routing. The rest is
 * declared on each route, so reading a route file tells you exactly who may
 * call it and with what.
 */
app.use(requestId);

if (!config.isTest) {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

/**
 * Log voice uploads at the request boundary, before JSON parsing and route
 * validation. This distinguishes a client-side file/base64 failure (no log at
 * all) from a request that reached Express but was interrupted or rejected.
 * Never log the request body: it contains the recording.
 */
app.use((req, _res, next) => {
  if (req.method === 'POST' && /^\/api\/v1\/prescriptions\/[^/]+\/voice\/segments$/.test(req.path)) {
    const id = req.id ?? '-';
    logger.info(
      `[voice] upload ingress requestId=${id} contentType=${req.get('content-type') ?? '-'} ` +
        `contentLength=${req.get('content-length') ?? 'unknown'} transferEncoding=${req.get('transfer-encoding') ?? '-'}`,
    );
    req.once('aborted', () => {
      logger.warn(`[voice] upload aborted by client requestId=${id} receivedBytes=${req.socket.bytesRead}`);
    });
  }
  next();
});

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
 *
 * This covers /files too, which the web app PUTs report pages to under the
 * local storage driver. That PUT carries a Content-Type of image/jpeg or
 * application/pdf, so the browser preflights it; PUT and Content-Type are both
 * allowed here, and ETag is exposed the way a bucket's CORS rule exposes it.
 */
const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || config.cors.origins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new AppError('FORBIDDEN', 'Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Practice-Id', 'X-Location-Id', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'ETag'],
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
