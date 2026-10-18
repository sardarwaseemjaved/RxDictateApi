import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { syncCollections } from '../../src/models';
import { removeAllListeners } from '../../src/core/events';
import { clearSessionCache } from '../../src/services/session.service';

/**
 * An in-memory mongod per test file.
 *
 * Hermetic on purpose: the suite must pass on a laptop with no mongod
 * installed and in CI without a service container. Indexes are built once, so
 * the unique and text indexes the code relies on are actually exercised.
 */
const setupTestDB = (): void => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await syncCollections();
  }, 120_000);

  beforeEach(async () => {
    // The session cache is in process, so it outlives the collections.
    clearSessionCache();
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})));
  });

  afterAll(async () => {
    removeAllListeners();
    await mongoose.disconnect();
    await mongod.stop();
  });
};

export default setupTestDB;
