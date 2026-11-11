import { scopeFrom } from '../core/tenancy';
import * as teamService from '../services/team.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { AddMemberBody, AddOrganisationMemberBody, ListMembersQuery, UpdateMemberBody } from '../shared/team.schema';

/** Which kind of organisation this is: resolveOrganisation has already checked the route serves it. */
const kindOf = (req: Parameters<typeof scopeFrom>[0]) => req.ctx!.organisationType;

export const listMembers = catchAsync(async (req, res) => {
  sendData(res, await teamService.listMembers(scopeFrom(req), parsedQuery<ListMembersQuery>(req)));
});

export const addMember = catchAsync(async (req, res) => {
  const kind = kindOf(req);
  sendCreated(
    res,
    kind === 'clinic'
      ? await teamService.addMember(scopeFrom(req), req.body as AddMemberBody)
      : await teamService.addOrganisationMember(scopeFrom(req), kind, req.body as AddOrganisationMemberBody),
  );
});

export const updateMember = catchAsync(async (req, res) => {
  sendData(res, await teamService.updateMember(scopeFrom(req), req.params.id, req.body as UpdateMemberBody));
});

export const removeMember = catchAsync(async (req, res) => {
  sendData(res, await teamService.removeMember(scopeFrom(req), req.params.id, kindOf(req)));
});
