import { scopeFrom } from '../core/tenancy';
import * as teamService from '../services/team.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { AddMemberBody, ListMembersQuery, UpdateMemberBody } from '../shared/team.schema';

export const listMembers = catchAsync(async (req, res) => {
  sendData(res, await teamService.listMembers(scopeFrom(req), parsedQuery<ListMembersQuery>(req)));
});

export const addMember = catchAsync(async (req, res) => {
  sendCreated(res, await teamService.addMember(scopeFrom(req), req.body as AddMemberBody));
});

export const updateMember = catchAsync(async (req, res) => {
  sendData(res, await teamService.updateMember(scopeFrom(req), req.params.id, req.body as UpdateMemberBody));
});

export const removeMember = catchAsync(async (req, res) => {
  sendData(res, await teamService.removeMember(scopeFrom(req), req.params.id));
});
