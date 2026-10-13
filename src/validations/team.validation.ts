import { idParamSchema } from '../shared/common';
import { addMemberBodySchema, listMembersQuerySchema, updateMemberBodySchema } from '../shared/team.schema';

export const listMembers = { query: listMembersQuerySchema };
export const addMember = { body: addMemberBodySchema };
export const updateMember = { params: idParamSchema, body: updateMemberBodySchema };
export const removeMember = { params: idParamSchema };
