import { auditScope } from '../core/audit';
import { can } from '../core/permissions';
import * as announcementService from '../services/announcement.service';
import * as announcementSlotService from '../services/announcementSlot.service';
import catchAsync from '../utils/catchAsync';
import { parsedBody, parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type {
  AnnouncementEventBody,
  AnnouncementPeopleQuery,
  AnnouncementReachQuery,
  AnnouncementSlotsQuery,
  AudienceCountBody,
  CreateAnnouncementBody,
  CreateAnnouncementImageBody,
  ListAnnouncementRegistrationsQuery,
  ListAnnouncementsQuery,
  SearchAnnouncementProductsQuery,
  UpdateAnnouncementBody,
} from '../shared/announcement.schema';

/* The console. */

export const searchProducts = catchAsync(async (req, res) => {
  sendData(res, await announcementService.searchProducts(parsedQuery<SearchAnnouncementProductsQuery>(req)));
});

export const listAnnouncements = catchAsync(async (req, res) => {
  const { announcements, meta } = await announcementService.listAnnouncements(
    auditScope(req),
    parsedQuery<ListAnnouncementsQuery>(req),
  );
  sendData(res, announcements, meta);
});

export const searchPeople = catchAsync(async (req, res) => {
  sendData(res, await announcementService.searchPeople(parsedQuery<AnnouncementPeopleQuery>(req)));
});

export const reach = catchAsync(async (req, res) => {
  const { rows, meta } = await announcementService.reach(auditScope(req), parsedQuery<AnnouncementReachQuery>(req));
  sendData(res, rows, meta);
});

export const getAnnouncement = catchAsync(async (req, res) => {
  sendData(res, await announcementService.getAnnouncement(req.params.id));
});

export const createAnnouncement = catchAsync(async (req, res) => {
  sendCreated(res, await announcementService.createAnnouncement(auditScope(req), parsedBody<CreateAnnouncementBody>(req)));
});

export const updateAnnouncement = catchAsync(async (req, res) => {
  sendData(
    res,
    await announcementService.updateAnnouncement(auditScope(req), req.params.id, parsedBody<UpdateAnnouncementBody>(req)),
  );
});

export const publishAnnouncement = catchAsync(async (req, res) => {
  sendData(res, await announcementService.publishAnnouncement(auditScope(req), req.params.id));
});

export const withdrawAnnouncement = catchAsync(async (req, res) => {
  sendData(res, await announcementService.withdrawAnnouncement(auditScope(req), req.params.id));
});

export const createImageUpload = catchAsync(async (req, res) => {
  sendCreated(
    res,
    await announcementService.createImageUpload(auditScope(req), parsedBody<CreateAnnouncementImageBody>(req)),
  );
});

/** The console counts any audience; a company, which cannot read announcements, only one by rule. */
export const audienceCount = catchAsync(async (req, res) => {
  const byRuleOnly = !can(req.ctx!.role, 'announcement.read');
  sendData(res, await announcementService.audienceCount(parsedBody<AudienceCountBody>(req).audience, byRuleOnly));
});

export const getStats = catchAsync(async (req, res) => {
  sendData(res, await announcementService.getStats(req.params.id));
});

export const listRegistrations = catchAsync(async (req, res) => {
  const { registrations, meta } = await announcementService.listRegistrations(
    req.params.id,
    parsedQuery<ListAnnouncementRegistrationsQuery>(req),
  );
  sendData(res, registrations, meta);
});

/** A file, not the JSON envelope: it is downloaded, not read by an app. */
export const registrationsCsv = catchAsync(async (req, res) => {
  const { filename, csv } = await announcementService.registrationsCsv(req.params.id);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(csv);
});

/* A clinic member. */

export const slots = catchAsync(async (req, res) => {
  sendData(res, await announcementSlotService.slotsFor(auditScope(req), parsedQuery<AnnouncementSlotsQuery>(req).placement));
});

export const recordEvent = catchAsync(async (req, res) => {
  sendData(
    res,
    await announcementSlotService.recordEvent(auditScope(req), req.params.id, parsedBody<AnnouncementEventBody>(req).type),
  );
});

export const setReminder = catchAsync(async (req, res) => {
  sendData(res, await announcementSlotService.setReminder(auditScope(req), req.params.id));
});

export const cancelReminder = catchAsync(async (req, res) => {
  sendData(res, await announcementSlotService.cancelReminder(auditScope(req), req.params.id));
});

export const register = catchAsync(async (req, res) => {
  sendData(res, await announcementSlotService.register(auditScope(req), req.params.id));
});

export const unregister = catchAsync(async (req, res) => {
  sendData(res, await announcementSlotService.unregister(auditScope(req), req.params.id));
});
