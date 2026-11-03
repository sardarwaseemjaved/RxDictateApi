import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import logger from '../../src/config/logger';
import { Vital, syncCollections } from '../../src/models';

/**
 * A database older than the code. `vitals.visitId_1` was first built without
 * `unique`, and createIndexes will neither change an index nor replace one of
 * the same name, so such a database warns on every boot and never gets the rule
 * until syncCollections does it.
 */
describe('syncCollections on an older database', () => {
  let mongod: MongoMemoryServer;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
  }, 120_000);

  beforeEach(async () => {
    // Mongoose builds indexes on connect as well, and it must not race this setup.
    await Vital.init();
    await mongoose.connection.dropDatabase();
    await Vital.createCollection();
    await Vital.collection.createIndex({ visitId: 1 });
  }, 60_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
  });

  const visitIndex = async () => (await Vital.collection.indexes()).find((index) => index.name === 'visitId_1');

  const reading = (visitId: Types.ObjectId) => ({
    practiceId: new Types.ObjectId(),
    visitId,
    recordedBy: new Types.ObjectId(),
    createdBy: new Types.ObjectId(),
  });

  test('the old index becomes the unique one, with no warning, and readings are kept', async () => {
    await Vital.collection.insertOne(reading(new Types.ObjectId()));
    const warn = jest.spyOn(logger, 'warn');

    await syncCollections();

    expect(warn).not.toHaveBeenCalled();
    expect((await visitIndex())?.unique).toBe(true);
    expect(await Vital.countDocuments()).toBe(1);

    // And it is left alone from then on.
    await syncCollections();
    expect(warn).not.toHaveBeenCalled();
  });

  test('two readings for one visit keep the old index, and it says why rather than losing the index', async () => {
    const visitId = new Types.ObjectId();
    await Vital.collection.insertMany([reading(visitId), reading(visitId)]);
    const warn = jest.spyOn(logger, 'warn');

    await syncCollections();

    expect(await visitIndex()).toBeDefined();
    expect((await visitIndex())?.unique).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 visit has more than one set of vitals'));
    expect(await Vital.countDocuments()).toBe(2);
  });
});
