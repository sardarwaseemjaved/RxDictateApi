import { Types } from 'mongoose';
import { Membership, Notification, type INotification, type NotificationDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import type {
  ListNotificationsQuery,
  MarkNotificationsReadBody,
  NotificationType,
  NotificationView,
  NotificationsMeta,
} from '../shared/notification.schema';

// Not soft-deleted: a notification is read or it is not.
const notifications = new BaseRepository<INotification>(Notification, { softDelete: false });

export interface NewNotification {
  practiceId: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationType;
  refId?: Types.ObjectId | null;
  title: string;
  body: string;
  actorId?: Types.ObjectId | null;
}

/**
 * Written now, read by nothing yet. Only listeners call this: a service that
 * wrote a notification directly would be a service that has to be edited when
 * push notifications arrive.
 */
export const notify = async (notification: NewNotification): Promise<void> => {
  await Notification.create({
    practiceId: notification.practiceId,
    userId: notification.userId,
    type: notification.type,
    refId: notification.refId ?? null,
    title: notification.title,
    body: notification.body,
    createdBy: notification.actorId ?? null,
  });
};

/** Everyone holding a role in this practice, which is who most events concern. */
export const membersOf = async (
  practiceId: Types.ObjectId,
  roles: ('doctor' | 'pa')[] = ['doctor', 'pa'],
): Promise<Types.ObjectId[]> => {
  const memberships = await Membership.find({ practiceId, status: 'active', role: { $in: roles } }).select('userId');
  return memberships.map((membership) => membership.userId);
};

/**
 * Fan out to the practice, skipping whoever caused the event: nobody needs to
 * be told about something they just did.
 */
export const notifyPractice = async (
  notification: Omit<NewNotification, 'userId'> & { roles?: ('doctor' | 'pa')[] },
): Promise<void> => {
  const userIds = await membersOf(notification.practiceId, notification.roles);
  await Promise.all(
    userIds
      .filter((userId) => !notification.actorId || !userId.equals(notification.actorId))
      .map((userId) => notify({ ...notification, userId })),
  );
};

const toNotificationView = (notification: NotificationDoc): NotificationView => ({
  id: String(notification._id),
  type: notification.type,
  refId: notification.refId ? String(notification.refId) : null,
  title: notification.title,
  body: notification.body,
  readAt: notification.readAt,
  createdAt: notification.createdAt,
});

/**
 * This person's inbox in this clinic, newest first.
 *
 * `meta.unread` is the badge: every unread notification, not the unread ones
 * on this page, because a badge that only counts the first twenty is worse
 * than no badge.
 */
export const listNotifications = async (
  scope: Scope,
  query: ListNotificationsQuery,
): Promise<{ notifications: NotificationView[]; meta: NotificationsMeta }> => {
  const mine = { userId: scope.actorId };

  const result = await notifications.paginate(
    scope,
    { ...mine, ...(query.unreadOnly ? { readAt: null } : {}) },
    { page: query.page, limit: query.limit, sortBy: 'createdAt:desc' },
  );
  const unread = await notifications.count(scope, { ...mine, readAt: null });

  return {
    notifications: result.results.map(toNotificationView),
    meta: {
      page: result.page,
      limit: result.limit,
      total: result.totalResults,
      totalPages: result.totalPages,
      unread,
    },
  };
};

/**
 * Mark some as read. Scoped to the caller's own rows, so a well-formed id
 * belonging to somebody else simply matches nothing.
 */
export const markRead = async (scope: Scope, body: MarkNotificationsReadBody): Promise<{ read: number; unread: number }> => {
  const result = await Notification.updateMany(
    notifications.scopedFilter(scope, {
      _id: { $in: body.ids.map((id) => new Types.ObjectId(id)) },
      userId: scope.actorId,
      readAt: null,
    }),
    { $set: { readAt: new Date() } },
  );

  const unread = await notifications.count(scope, { userId: scope.actorId, readAt: null });
  return { read: result.modifiedCount, unread };
};

export default { notify, notifyPractice, membersOf, listNotifications, markRead, toNotificationView };
