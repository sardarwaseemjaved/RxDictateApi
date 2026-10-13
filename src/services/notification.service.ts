import type { Types } from 'mongoose';
import { Membership, Notification } from '../models';
import type { NotificationType } from '../shared/notification.schema';

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

export default { notify, notifyPractice, membersOf };
