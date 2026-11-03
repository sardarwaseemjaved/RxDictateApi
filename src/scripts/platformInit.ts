/**
 * Makes RxDictate's own organisation, the platform, and its first admin.
 *
 *   yarn platform:init --phone +923001234567 [--name "Your name"]
 *   node dist/scripts/platformInit.js --phone ...    (on the server)
 *
 * Creates the platform organisation if there is none, and gives the phone a
 * platformAdmin membership in it, creating the user if nobody has signed in
 * with that number yet. That person then signs in with the phone like anyone
 * else, and their GET /me lists the platform alongside any clinic.
 *
 * Safe to run twice: a second run for the same phone changes nothing. Run it
 * with another phone to add a second admin. Writes to the database MONGODB_URL
 * names.
 */
import mongoose from 'mongoose';
import config from '../config/config';
import logger from '../config/logger';
import { syncCollections } from '../models';
import { initPlatform } from '../services/organisation.service';

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

const run = async (): Promise<void> => {
  const phone = argument('phone')?.replace(/[\s-]/g, '');
  const name = argument('name')?.trim() || undefined;
  if (!phone) {
    throw new Error('Usage: --phone +923001234567 [--name "Your name"]');
  }

  await mongoose.connect(config.mongoose.url);
  logger.info(`Connected to database "${mongoose.connection.name}" on ${mongoose.connection.host}`);
  // The index that allows only one platform has to exist before one is made.
  await syncCollections();

  const result = await initPlatform(phone, name);

  logger.info(
    result.createdOrganisation
      ? `Made the platform organisation (${String(result.organisationId)})`
      : `The platform organisation already exists (${String(result.organisationId)})`,
  );
  if (result.createdUser) {
    logger.info(`Made a user for ${phone}; they sign in with that number`);
  }
  logger.info(
    result.grantedAdmin ? `${phone} is now a platform admin` : `${phone} was already a platform admin; nothing changed`,
  );
};

run()
  .catch((error: Error) => {
    logger.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
