import type { Types } from 'mongoose';
import { Submission, type SubmissionDoc } from '../models';
import type { SubmissionSummary, SubmissionType } from '../shared/submissionStatus';

/**
 * The latest submission about each of these rows, as shown beside a product or
 * a clinic's item. Kept apart from the review service so the list code can
 * read it without importing everything approval touches.
 */

export const toSubmissionSummary = (submission: SubmissionDoc): SubmissionSummary => ({
  id: String(submission._id),
  type: submission.type,
  status: submission.status,
  note: submission.note,
  updatedAt: submission.updatedAt,
});

/**
 * By drug id. Only this organisation's own submissions, and only these types:
 * a company never sees a clinic's proposal about the same row, or the other
 * way round.
 */
export const latestSubmissionsFor = async (
  practiceId: Types.ObjectId,
  drugIds: Types.ObjectId[],
  types: readonly SubmissionType[],
): Promise<Map<string, SubmissionSummary>> => {
  if (drugIds.length === 0) {
    return new Map();
  }
  const found = await Submission.find({ practiceId, drugId: { $in: drugIds }, type: { $in: types } }).sort({
    createdAt: -1,
    _id: -1,
  });
  const latest = new Map<string, SubmissionSummary>();
  found.forEach((submission) => {
    const key = String(submission.drugId);
    if (!latest.has(key)) {
      latest.set(key, toSubmissionSummary(submission));
    }
  });
  return latest;
};

export default { toSubmissionSummary, latestSubmissionsFor };
