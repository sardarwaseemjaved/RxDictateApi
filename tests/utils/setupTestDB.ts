import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

/**
 * An in-memory mongod per test file.
 *
 * Hermetic on purpose: the suite must pass on a laptop with no mongod installed
 * and in CI without a service container.
 */
const setupTestDB = (): void => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 120_000);

  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map(async (collection) => collection.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });
};

export default setupTestDB;
