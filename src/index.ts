import mongoose from 'mongoose';
import type { Server } from 'http';
import app from './app';
import config from './config/config';
import logger from './config/logger';
import { syncCollections } from './models';
import { sweepExpiredAudio, sweepStalledSegments } from './services/voice.service';
import { markExpiredSessions } from './services/session.service';
import { backfillQueuePositions } from './services/visit.service';
import { backfillPatientLocations } from './services/patient.service';

let server: Server | undefined;

/**
 * Two housekeeping jobs, on plain timers.
 *
 * There is no queue in this product yet and these do not need one: both are
 * idempotent, both are cheap, and both would otherwise need a scheduler to be
 * stood up before the first doctor can use the app. The timers are unref'd so
 * they never hold the process open.
 *
 * - Dictation audio is deleted once practice.settings.audioRetentionDays have
 *   passed since approval. The transcript stays; the recording of a patient's
 *   voice does not.
 * - A segment whose processing began and never finished - because this process
 *   restarted mid-transcription - is marked failed, so the segments queued
 *   behind it are not stuck forever.
 * - A session past its expiry is marked revoked, so it reads as ended rather
 *   than sitting there technically usable until Mongo's TTL removes it a month
 *   later.
 */
const startSweeps = (): void => {
  const run = (what: string, job: () => Promise<number>) => {
    job().catch((error: Error) => logger.error(`${what} sweep failed: ${error.message}`));
  };

  run('stalled segment', sweepStalledSegments);
  run('audio retention', sweepExpiredAudio);
  run('expired session', markExpiredSessions);

  setInterval(() => run('stalled segment', sweepStalledSegments), 5 * 60 * 1000).unref();
  setInterval(() => run('audio retention', sweepExpiredAudio), 6 * 60 * 60 * 1000).unref();
  setInterval(() => run('expired session', markExpiredSessions), 24 * 60 * 60 * 1000).unref();
};

const start = async (): Promise<void> => {
  await mongoose.connect(config.mongoose.url);
  logger.info('Connected to MongoDB');
  logger.info(
    `Voice configuration: stt=${config.voice.sttProvider} (${config.openai.sttModel}), ` +
      `llm=${config.voice.llmProvider} (${config.openai.model}), timeoutMs=${config.voice.segmentTimeoutMs}`,
  );

  // Every collection and index exists from the first boot, including the ones
  // no route touches yet.
  await syncCollections();

  // Before the first request, so no list is ever read without its order.
  const backfilled = await backfillQueuePositions();
  if (backfilled > 0) {
    logger.info(`gave ${backfilled} visit(s) a queue position from their token`);
  }

  // Also before the first request: until it has run, an assistant would see
  // none of the patients registered before patients had locations.
  const linked = await backfillPatientLocations();
  if (linked > 0) {
    logger.info(`linked ${linked} patient(s) to the locations they were seen at`);
  }

  if (config.otp.fixedCode) {
    logger.warn(`every sign-in code is fixed to ${config.otp.fixedCode} - testing only; this is ignored in production`);
  }

  server = app.listen(config.port, () => {
    logger.info(`Listening to port ${config.port}`);
  });

  startSweeps();
};

const exitHandler = () => {
  if (server) {
    server.close(() => {
      logger.info('Server closed');
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = (error: unknown) => {
  logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  if (server) {
    server.close();
  }
});

start().catch(unexpectedErrorHandler);
