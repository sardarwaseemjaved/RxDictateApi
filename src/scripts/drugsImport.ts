/**
 * The national catalog, from a file of DRAP's registered products.
 *
 *   yarn drugs:import <file.csv> [--dry-run] [--discontinue-missing]
 *   node dist/scripts/drugsImport.js <file.csv> ...    (on the server)
 *
 * Columns, in any order: registrationNo, brand, composition, strength, form,
 * pack, company. Safe to run twice: keyed by registration number, a new one is
 * inserted and a known one updated. Nothing is ever removed unless
 * --discontinue-missing says so, and --dry-run changes nothing at all.
 *
 * Writes to the database MONGODB_URL names.
 */
import { readFileSync } from 'fs';
import mongoose from 'mongoose';
import config from '../config/config';
import logger from '../config/logger';
import { syncCollections } from '../models';
import { importDrugs } from '../services/drugImport.service';

const run = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith('--'));
  if (!file) {
    throw new Error('Usage: <file.csv> [--dry-run] [--discontinue-missing]');
  }
  const csv = readFileSync(file, 'utf8');

  await mongoose.connect(config.mongoose.url);
  logger.info(`Connected to database "${mongoose.connection.name}" on ${mongoose.connection.host}`);
  const dryRun = args.includes('--dry-run');
  // The indexes have to be right before rows go in: the old one refuses two packs of one product.
  // A dry run only reads, and changes nothing, indexes included.
  if (!dryRun) {
    await syncCollections();
  }

  const summary = await importDrugs(csv, {
    dryRun,
    discontinueMissing: args.includes('--discontinue-missing'),
  });

  logger.info(summary.dryRun ? 'Dry run: nothing was changed. It would have:' : 'Done:');
  logger.info(`  inserted     ${summary.inserted}`);
  logger.info(`  updated      ${summary.updated}`);
  logger.info(`  discontinued ${summary.discontinued}`);
  logger.info(`  skipped      ${summary.skipped.length}`);
  summary.skipped.forEach(({ line, registrationNo, reason }) => {
    logger.info(`    line ${line}${registrationNo ? ` (${registrationNo})` : ''}: ${reason}`);
  });
};

run()
  .catch((error: Error) => {
    logger.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
