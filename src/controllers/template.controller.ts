import { scopeFrom } from '../core/tenancy';
import * as templateService from '../services/template.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { CreateTemplateBody, ListTemplatesQuery, UpdateTemplateBody } from '../shared/template.schema';

export const listTemplates = catchAsync(async (req, res) => {
  const { templates, meta } = await templateService.listTemplates(scopeFrom(req), parsedQuery<ListTemplatesQuery>(req));
  sendData(res, templates, meta);
});

export const getTemplate = catchAsync(async (req, res) => {
  sendData(res, await templateService.getTemplate(scopeFrom(req), req.params.id));
});

export const createTemplate = catchAsync(async (req, res) => {
  sendCreated(res, await templateService.createTemplate(scopeFrom(req), req.body as CreateTemplateBody));
});

export const updateTemplate = catchAsync(async (req, res) => {
  sendData(res, await templateService.updateTemplate(scopeFrom(req), req.params.id, req.body as UpdateTemplateBody));
});

export const deleteTemplate = catchAsync(async (req, res) => {
  sendData(res, await templateService.deleteTemplate(scopeFrom(req), req.params.id));
});
