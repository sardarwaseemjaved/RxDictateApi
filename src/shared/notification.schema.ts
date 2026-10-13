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

export const markNotificationsReadBodySchema = z.object({
  ids: z.array(objectIdSchema).min(1).max(200),
});
export type MarkNotificationsReadBody = z.infer<typeof markNotificationsReadBodySchema>;

export const registerDeviceBodySchema = z.object({
  pushToken: z.string().min(1).max(500),
  platform: z.enum(['ios', 'android']),
});
export type RegisterDeviceBody = z.infer<typeof registerDeviceBodySchema>;
