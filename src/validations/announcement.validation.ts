import { idParamSchema } from '../shared/common';
import {
  announcementEventBodySchema,
  announcementSlotsQuerySchema,
  audienceCountBodySchema,
  createAnnouncementBodySchema,
  createAnnouncementImageBodySchema,
  listAnnouncementRegistrationsQuerySchema,
  listAnnouncementsQuerySchema,
  registerAnnouncementBodySchema,
  searchAnnouncementProductsQuerySchema,
  updateAnnouncementBodySchema,
} from '../shared/announcement.schema';

// The console.
export const listAnnouncements = { query: listAnnouncementsQuerySchema };
export const searchProducts = { query: searchAnnouncementProductsQuerySchema };
export const getAnnouncement = { params: idParamSchema };
export const createAnnouncement = { body: createAnnouncementBodySchema };
export const updateAnnouncement = { params: idParamSchema, body: updateAnnouncementBodySchema };
export const changeStatus = { params: idParamSchema };
export const createImageUpload = { body: createAnnouncementImageBodySchema };
export const audienceCount = { body: audienceCountBodySchema };
export const listRegistrations = { params: idParamSchema, query: listAnnouncementRegistrationsQuerySchema };

// A clinic member.
export const slots = { query: announcementSlotsQuerySchema };
export const recordEvent = { params: idParamSchema, body: announcementEventBodySchema };
export const reminder = { params: idParamSchema };
export const register = { params: idParamSchema, body: registerAnnouncementBodySchema };
export const unregister = { params: idParamSchema };
