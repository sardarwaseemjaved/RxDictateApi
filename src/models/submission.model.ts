import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import {
  submissionStatusSchema,
  submissionTypeSchema,
  type SubmissionStatus,
  type SubmissionType,
} from '../shared/submissionStatus';
import { submissionStepSchema, type SubmissionStep } from '../shared/submission.schema';

export interface ISubmissionStep {
  step: SubmissionStep;
  at: Date;
  by: Types.ObjectId;
  note: string | null;
  /** What was sent at this step, when something was: the first submission and each resubmission. */
  payload: Record<string, unknown> | null;
}

/**
 * The review queue: anything sent from outside the platform that would change
 * what a doctor sees, held until a reviewer approves it. One collection for
 * every type; what a type means lives in its handler (submission.service).
 *
 * `practiceId` is the organisation that sent it - a company, or a clinic for a
 * proposal - so a sender's reads go through the scoped repository like every
 * other tenant's. A reviewer reads across organisations, and only the review
 * routes, which only the platform reaches, do that.
 */
export interface ISubmission {
  type: SubmissionType;
  payload: Record<string, unknown>;
  practiceId: Types.ObjectId;
  submittedBy: Types.ObjectId;
  /** What it is about, when it is about a row that exists. */
  drugId: Types.ObjectId | null;
  /** Rows sent in one CSV upload share this. */
  uploadId: string | null;
  status: SubmissionStatus;
  /** Open ones first in the queue: 0 pending, 1 changes requested, 2 closed. Kept with status. */
  queueRank: number;
  reviewerId: Types.ObjectId | null;
  note: string | null;
  duplicateOfId: Types.ObjectId | null;
  resultDrugId: Types.ObjectId | null;
  /** Once an `announcement.create` is approved: the draft it made. */
  resultAnnouncementId: Types.ObjectId | null;
  history: ISubmissionStep[];
  submittedAt: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type SubmissionDoc = HydratedDocument<ISubmission>;

export const QUEUE_RANK: Record<SubmissionStatus, number> = {
  pending: 0,
  changesRequested: 1,
  approved: 2,
  rejected: 2,
  withdrawn: 2,
};

const stepSchema = new Schema<ISubmissionStep>(
  {
    step: { type: String, enum: submissionStepSchema.options, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    note: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false, minimize: false },
);

const submissionSchema = new Schema<ISubmission>(
  {
    type: { type: String, enum: submissionTypeSchema.options, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    drugId: { type: Schema.Types.ObjectId, ref: 'Drug', default: null },
    uploadId: { type: String, default: null },
    status: { type: String, enum: submissionStatusSchema.options, default: 'pending' },
    queueRank: { type: Number, default: 0 },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: null },
    duplicateOfId: { type: Schema.Types.ObjectId, ref: 'Drug', default: null },
    resultDrugId: { type: Schema.Types.ObjectId, ref: 'Drug', default: null },
    resultAnnouncementId: { type: Schema.Types.ObjectId, ref: 'Announcement', default: null },
    history: { type: [stepSchema], default: [] },
    submittedAt: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, minimize: false },
);

submissionSchema.plugin(toJSON);
submissionSchema.plugin(paginate);

// The reviewer's queue, open first and oldest first, optionally by status or type.
submissionSchema.index({ queueRank: 1, submittedAt: 1 });
submissionSchema.index({ status: 1, type: 1, submittedAt: 1 });
// A sender's own, and what is open about one row.
submissionSchema.index({ practiceId: 1, queueRank: 1, submittedAt: 1 });
submissionSchema.index({ drugId: 1, status: 1 });
// The latest submission about a row includes the one that made it.
submissionSchema.index({ resultDrugId: 1 }, { partialFilterExpression: { resultDrugId: { $type: 'objectId' } } });
submissionSchema.index({ uploadId: 1 }, { partialFilterExpression: { uploadId: { $type: 'string' } } });

export const Submission = mongoose.model<ISubmission, PaginateModel<ISubmission>>(
  'Submission',
  submissionSchema,
  'submissions',
);
export default Submission;
