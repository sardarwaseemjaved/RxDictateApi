import type { Request } from 'express';
import { auditScope } from '../core/audit';
import * as submissionService from '../services/submission.service';
import catchAsync from '../utils/catchAsync';
import { parsedBody, parsedQuery } from '../utils/request';
import { sendData } from '../utils/response';
import type {
  ApproveSubmissionBody,
  ListSubmissionsQuery,
  RejectSubmissionBody,
  RequestChangesBody,
  ResubmitSubmissionBody,
} from '../shared/submission.schema';

/** Who is looking, and from what kind of organisation: the platform sees every one, a sender its own. */
const viewer = (req: Request): submissionService.Viewer => ({
  scope: auditScope(req),
  organisationType: req.ctx!.organisationType,
});

export const listSubmissions = catchAsync(async (req, res) => {
  const { submissions, meta } = await submissionService.listSubmissions(viewer(req), parsedQuery<ListSubmissionsQuery>(req));
  sendData(res, submissions, meta);
});

export const getSubmission = catchAsync(async (req, res) => {
  sendData(res, await submissionService.getSubmission(viewer(req), req.params.id));
});

export const resubmit = catchAsync(async (req, res) => {
  sendData(res, await submissionService.resubmit(viewer(req), req.params.id, parsedBody<ResubmitSubmissionBody>(req)));
});

export const withdraw = catchAsync(async (req, res) => {
  sendData(res, await submissionService.withdraw(viewer(req), req.params.id));
});

export const approve = catchAsync(async (req, res) => {
  sendData(res, await submissionService.approve(auditScope(req), req.params.id, parsedBody<ApproveSubmissionBody>(req)));
});

export const reject = catchAsync(async (req, res) => {
  sendData(res, await submissionService.reject(auditScope(req), req.params.id, parsedBody<RejectSubmissionBody>(req)));
});

export const requestChanges = catchAsync(async (req, res) => {
  sendData(res, await submissionService.requestChanges(auditScope(req), req.params.id, parsedBody<RequestChangesBody>(req)));
});
