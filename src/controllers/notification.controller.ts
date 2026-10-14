import { scopeFrom } from '../core/tenancy';
import * as notificationService from '../services/notification.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendData } from '../utils/response';
import type { ListNotificationsQuery, MarkNotificationsReadBody } from '../shared/notification.schema';

export const listNotifications = catchAsync(async (req, res) => {
  const { notifications, meta } = await notificationService.listNotifications(
    scopeFrom(req),
    parsedQuery<ListNotificationsQuery>(req),
  );
  sendData(res, notifications, meta);
});

export const markRead = catchAsync(async (req, res) => {
  sendData(res, await notificationService.markRead(scopeFrom(req), req.body as MarkNotificationsReadBody));
});
