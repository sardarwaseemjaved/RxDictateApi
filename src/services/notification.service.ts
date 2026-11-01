import { Types } from 'mongoose';
import { Membership, Notification, type INotification, type NotificationDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { emit } from '../core/events';
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

const write = async (notification: NewNotification): Promise<void> => {
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

/**
 * Into one person's inbox. Only listeners call this: a service that wrote a
 * notification directly would be a service that has to be edited when push
 * notifications arrive.
 */
export const notify = async (notification: NewNotification): Promise<void> => {
  await write(notification);
  emit('notification.created', { practiceId: notification.practiceId, userIds: [notification.userId] });
};

/**
 * Everyone holding a role in this practice, which is who most events concern.
 *
 * With a location, a PA is included only when assigned to it - the same rule
 * resolveLocation holds them to. A doctor works at every location of their
 * practice and is never filtered out by one.
 */
export const membersOf = async (
  practiceId: Types.ObjectId,
  roles?: ('doctor' | 'pa')[],
  locationId?: Types.ObjectId,
): Promise<Types.ObjectId[]> => {
  const memberships = await Membership.find({
    practiceId,
    status: 'active',
    role: { $in: roles ?? ['doctor', 'pa'] },
    ...(locationId ? { $or: [{ role: 'doctor' }, { locationIds: locationId }] } : {}),
  }).select('userId');
  return memberships.map((membership) => membership.userId);
};

/**
 * Fan out to the practice, skipping whoever caused the event: nobody needs to
 * be told about something they just did.
 */
export const notifyPractice = async (
  notification: Omit<NewNotification, 'userId'> & { roles?: ('doctor' | 'pa')[]; locationId?: Types.ObjectId },
): Promise<void> => {
  const { roles, locationId, ...rest } = notification;
  const members = await membersOf(rest.practiceId, roles, locationId);
  const userIds = members.filter((userId) => !rest.actorId || !userId.equals(rest.actorId));
  if (userIds.length === 0) {
    return;
  }

  await Promise.all(userIds.map((userId) => write({ ...rest, userId })));
  emit('notification.created', { practiceId: rest.practiceId, userIds });
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
  if (result.modifiedCount > 0) {
    emit('notification.read', { practiceId: scope.practiceId, userId: scope.actorId });
  }

  const unread = await notifications.count(scope, { userId: scope.actorId, readAt: null });
  return { read: result.modifiedCount, unread };
};

export default { notify, notifyPractice, membersOf, listNotifications, markRead, toNotificationView };
