import { z } from 'zod';
import { objectIdSchema } from './common';

/**
 * Notifications are written now and have no UI yet, so that turning them on
 * later means adding a screen, not backfilling a collection.
 */
export const notificationTypeSchema = z.enum([
  'patient.added',
  'visit.statusChanged',
  'prescription.approved',
  'prescription.revised',
  'member.added',
  'member.removed',
  'member.locationsChanged',
  'location.added',
  'location.archived',
  'report.uploaded',
  'vitals.recorded',
  'appointment.booked',
  'voice.segmentFailed',
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const notificationViewSchema = z.object({
  id: objectIdSchema,
  type: notificationTypeSchema,
  refId: objectIdSchema.nullable(),
  title: z.string(),
  body: z.string(),
  readAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

export const listNotificationsQuerySchema = z.object({
  /** Only the ones not yet read, for the badge's own list. */
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

/**
 * `unread` is the badge: every unread notification for this person in this
 * clinic, not just the ones on this page.
 */
export const notificationsMetaSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  unread: z.number().int(),
});
export type NotificationsMeta = z.infer<typeof notificationsMetaSchema>;

export const markNotificationsReadBodySchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(200),
});
export type MarkNotificationsReadBody = z.infer<typeof markNotificationsReadBodySchema>;

export const registerDeviceBodySchema = z.object({
  pushToken: z.string().min(1).max(500),
  platform: z.enum(['ios', 'android']),
});
export type RegisterDeviceBody = z.infer<typeof registerDeviceBodySchema>;
