import mongoose from 'mongoose';
import type { Server } from 'http';
import app from './app';
import config from './config/config';
import logger from './config/logger';
import { syncCollections } from './models';

let server: Server | undefined;

const start = async (): Promise<void> => {
  await mongoose.connect(config.mongoose.url);
  logger.info('Connected to MongoDB');

  // Every collection and index exists from the first boot, including the ones
  // no route touches yet.
  await syncCollections();

  server = app.listen(config.port, () => {
    logger.info(`Listening to port ${config.port}`);
  });
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
