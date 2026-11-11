import logger from '../config/logger';
import { Job, type JobDoc, type JobType } from '../models';
import { runReminder } from './announcementReminder.service';

/**
 * Running due jobs, for the sweep in src/index.ts.
 *
 * Each job is claimed (pending -> running) before it runs, so two sweeps that
 * find the same job run it once. A job's handler is quick - it emits an event
 * and a listener does the rest - so one that dies mid-run, with the process,
 * is left as `running` rather than retried; a reminder sent twice is worse
 * than one missed.
 */

type Handler = (job: JobDoc, now: Date) => Promise<'done' | 'skipped'>;

const HANDLERS: Record<JobType, Handler> = {
  'announcement.reminder': runReminder,
};

/** The most one sweep takes on; the rest wait for the next. */
const BATCH = 200;

/** Answers how many ran (not skipped or failed). */
export const runDueJobs = async (now: Date = new Date()): Promise<number> => {
  const due = await Job.find({ status: 'pending', runAt: { $lte: now } })
    .sort({ runAt: 1 })
    .limit(BATCH)
    .select('_id');

  const ran = await due.reduce<Promise<number>>(async (previous, { _id }) => {
    const count = await previous;
    const job = await Job.findOneAndUpdate({ _id, status: 'pending' }, { $set: { status: 'running' } }, { new: true });
    if (!job) {
      return count;
    }
    try {
      const outcome = await HANDLERS[job.type](job, now);
      await Job.updateOne({ _id }, { $set: { status: outcome, ranAt: now } });
      return outcome === 'done' ? count + 1 : count;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`job ${String(_id)} (${job.type}) failed: ${message}`);
      await Job.updateOne({ _id }, { $set: { status: 'failed', ranAt: now, error: message } });
      return count;
    }
  }, Promise.resolve(0));

  if (ran > 0) {
    logger.info(`ran ${ran} due job(s)`);
  }
  return ran;
};

export default { runDueJobs };
