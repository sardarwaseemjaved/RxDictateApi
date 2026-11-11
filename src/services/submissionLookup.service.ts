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
 * By drug id. A submission is about a row when it names it (`drugId`) or,
 * like an approved new product, made it (`resultDrugId`). Only this
 * organisation's own submissions, and only these types: a company never sees
 * a clinic's proposal about the same row, or the other way round.
 */
export const latestSubmissionsFor = async (
  practiceId: Types.ObjectId,
  drugIds: Types.ObjectId[],
  types: readonly SubmissionType[],
): Promise<Map<string, SubmissionSummary>> => {
  if (drugIds.length === 0) {
    return new Map();
  }
  const found = await Submission.find({
    practiceId,
    type: { $in: types },
    $or: [{ drugId: { $in: drugIds } }, { resultDrugId: { $in: drugIds } }],
  }).sort({ createdAt: -1, _id: -1 });
  const wanted = new Set(drugIds.map(String));
  const latest = new Map<string, SubmissionSummary>();
  found.forEach((submission) => {
    // Newest first, so the first one seen for a row is its latest. A merged
    // proposal names one row and made another; each row keeps its own.
    [submission.drugId, submission.resultDrugId].forEach((id) => {
      const key = id ? String(id) : null;
      if (key && wanted.has(key) && !latest.has(key)) {
        latest.set(key, toSubmissionSummary(submission));
      }
    });
  });
  return latest;
};

export default { toSubmissionSummary, latestSubmissionsFor };
