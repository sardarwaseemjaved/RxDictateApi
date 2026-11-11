import { idParamSchema } from '../shared/common';
import {
  approveSubmissionBodySchema,
  listSubmissionsQuerySchema,
  rejectSubmissionBodySchema,
  requestChangesBodySchema,
  resubmitSubmissionBodySchema,
} from '../shared/submission.schema';

export const listSubmissions = { query: listSubmissionsQuerySchema };
export const getSubmission = { params: idParamSchema };
export const resubmit = { params: idParamSchema, body: resubmitSubmissionBodySchema };
export const withdraw = { params: idParamSchema };
export const approve = { params: idParamSchema, body: approveSubmissionBodySchema };
export const reject = { params: idParamSchema, body: rejectSubmissionBodySchema };
export const requestChanges = { params: idParamSchema, body: requestChangesBodySchema };
