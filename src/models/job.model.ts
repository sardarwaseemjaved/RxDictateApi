import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

/**
 * Work to do at a time, swept by a timer in src/index.ts. There is no queue in
 * this product and at this scale none is needed: a sweep claims each due job
 * once, so two processes sweeping at the same moment still run it once.
 *
 * - `pending`: waiting for `runAt`.
 * - `running`: claimed by a sweep.
 * - `done`: ran.
 * - `skipped`: due, but no longer worth doing - the event already started,
 *   or the announcement was withdrawn.
 * - `cancelled`: taken back before it was due.
 * - `failed`: ran and threw; `error` says why. Not retried.
 */
export const JOB_TYPES = ['announcement.reminder'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'skipped', 'cancelled', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface IJob {
  type: JobType;
  runAt: Date;
  status: JobStatus;
  /** What it is about, such as the announcement. */
  refId: Types.ObjectId;
  /** Who it is for, and in which organisation, when it is for a person. */
  userId: Types.ObjectId | null;
  practiceId: Types.ObjectId | null;
  /** Anything else the type's handler needs. */
  data: Record<string, unknown>;
  ranAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobDoc = HydratedDocument<IJob>;

const jobSchema = new Schema<IJob>(
  {
    type: { type: String, enum: JOB_TYPES, required: true },
    runAt: { type: Date, required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'pending' },
    refId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', default: null },
    data: { type: Schema.Types.Mixed, default: {} },
    ranAt: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { timestamps: true, minimize: false },
);

// The sweep: what is due, oldest first.
jobSchema.index({ status: 1, runAt: 1 });
// Cancelling one person's, or everyone's, on one thing.
jobSchema.index({ refId: 1, type: 1, status: 1, userId: 1 });

export const Job = mongoose.model<IJob>('Job', jobSchema, 'jobs');
export default Job;
