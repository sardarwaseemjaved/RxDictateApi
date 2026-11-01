import { idParamSchema } from '../shared/common';
import { createTemplateBodySchema, listTemplatesQuerySchema, updateTemplateBodySchema } from '../shared/template.schema';

export const listTemplates = { query: listTemplatesQuerySchema };
export const getTemplate = { params: idParamSchema };
export const createTemplate = { body: createTemplateBodySchema };
export const updateTemplate = { params: idParamSchema, body: updateTemplateBodySchema };
export const deleteTemplate = { params: idParamSchema };
