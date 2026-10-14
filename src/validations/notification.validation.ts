import {
  listNotificationsQuerySchema,
  markNotificationsReadBodySchema,
  registerDeviceBodySchema,
} from '../shared/notification.schema';

export const listNotifications = { query: listNotificationsQuerySchema };
export const markRead = { body: markNotificationsReadBodySchema };
// Devices still answer 501; the shape is settled so the app can be written
// against it and nothing is renamed when push goes live.
export const registerDevice = { body: registerDeviceBodySchema };
