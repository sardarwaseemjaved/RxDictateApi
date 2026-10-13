import { markNotificationsReadBodySchema, registerDeviceBodySchema } from '../shared/notification.schema';
import { paginationQuerySchema } from '../shared/common';

// The routes answer 501 for now, but the shapes are settled so the app can be
// written against them and nothing is renamed when they go live.
export const listNotifications = { query: paginationQuerySchema };
export const markRead = { body: markNotificationsReadBodySchema };
export const registerDevice = { body: registerDeviceBodySchema };
