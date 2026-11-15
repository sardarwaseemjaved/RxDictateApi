import { idParamSchema } from '../shared/common';
import {
  claimProductBodySchema,
  companyCsvBodySchema,
  createCompanyBodySchema,
  createProductBodySchema,
  listCompaniesQuerySchema,
  listCompanyProductsQuerySchema,
  updateCompanyBodySchema,
  updateProductBodySchema,
} from '../shared/company.schema';
import {
  createCompanyAnnouncementBodySchema,
  listAnnouncementRegistrationsQuerySchema,
  listCompanyAnnouncementsQuerySchema,
} from '../shared/announcement.schema';

export const listCompanies = { query: listCompaniesQuerySchema };
export const getCompany = { params: idParamSchema };
export const createCompany = { body: createCompanyBodySchema };
export const updateCompany = { params: idParamSchema, body: updateCompanyBodySchema };
export const changeStatus = { params: idParamSchema };

export const listProducts = { query: listCompanyProductsQuerySchema };
export const createProduct = { body: createProductBodySchema };
export const updateProduct = { params: idParamSchema, body: updateProductBodySchema };
export const discontinueProduct = { params: idParamSchema };
export const claimProduct = { body: claimProductBodySchema };
export const csv = { body: companyCsvBodySchema };

export const listAnnouncements = { query: listCompanyAnnouncementsQuerySchema };
export const submitAnnouncement = { body: createCompanyAnnouncementBodySchema };
export const listAnnouncementRegistrations = { params: idParamSchema, query: listAnnouncementRegistrationsQuerySchema };
export const announcementRegistrationsCsv = { params: idParamSchema };
