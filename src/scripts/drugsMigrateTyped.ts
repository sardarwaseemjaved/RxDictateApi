/**
 * One-off: everything already in `drugs` came from typing, so none of it stays
 * national. Run once, straight after the release that added scopes.
 *
 *   yarn drugs:migrate-typed [--dry-run]
 *   node dist/scripts/drugsMigrateTyped.js [--dry-run]    (on the server)
 *
 * Each row becomes a doctor's own, for each doctor who prescribed it in an
 * approved prescription, on that doctor's list in that clinic, with usage
 * worked out from those prescriptions. A row nobody prescribed is dropped, and
 * listed here. Prescriptions are not touched.
 *
 * Safe to run twice. Writes to the database MONGODB_URL names.
 */
import mongoose from 'mongoose';
import config from '../config/config';
import logger from '../config/logger';
import { syncCollections } from '../models';
import { migrateTypedDrugs } from '../services/drugMigration.service';

const run = async (): Promise<void> => {
  await mongoose.connect(config.mongoose.url);
  logger.info(`Connected to database "${mongoose.connection.name}" on ${mongoose.connection.host}`);
  const dryRun = process.argv.includes('--dry-run');
  // The old unique index refuses one copy per doctor, so it has to be gone first.
  // A dry run only reads, and changes nothing, indexes included.
  if (!dryRun) {
    await syncCollections();
  }

  const summary = await migrateTypedDrugs({ dryRun });

  logger.info(summary.dryRun ? 'Dry run: nothing was changed. It would have:' : 'Done:');
  logger.info(`  typed rows found   ${summary.typedRows}`);
  logger.info(`  doctor rows        ${summary.doctorRows}`);
  logger.info(`  dropped, unused    ${summary.dropped.length}`);
  summary.dropped.forEach(({ brand, strength, form }) => {
    logger.info(`    ${[brand, strength, form].filter(Boolean).join(' ')}`);
  });
};

run()
  .catch((error: Error) => {
    logger.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
