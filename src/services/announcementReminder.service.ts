import type { Types } from 'mongoose';
import { Announcement, AnnouncementState, Job, Membership, type AnnouncementDoc, type JobDoc } from '../models';
import { emit } from '../core/events';

/**
 * Reminders for a seminar or an event: a bell notification a day before it
 * starts and an hour before, as jobs the sweep in src/index.ts runs. A time
 * that has already passed when the reminder is set is skipped, not sent late.
 */

const HOUR_MS = 60 * 60 * 1000;

export const REMINDER_LEADS = [
  { lead: 'day', beforeMs: 24 * HOUR_MS },
  { lead: 'hour', beforeMs: HOUR_MS },
] as const;

type Lead = (typeof REMINDER_LEADS)[number]['lead'];

/** This person's reminders on this announcement, from now on. Answers how many were scheduled. */
export const scheduleReminders = async (
  announcement: AnnouncementDoc,
  userId: Types.ObjectId,
  practiceId: Types.ObjectId,
  now: Date = new Date(),
): Promise<number> => {
  const startsAt = announcement.event?.startsAt;
  if (!startsAt) {
    return 0;
  }
  const due = REMINDER_LEADS.map(({ lead, beforeMs }) => ({ lead, runAt: new Date(startsAt.getTime() - beforeMs) })).filter(
    ({ runAt }) => runAt > now,
  );
  if (due.length > 0) {
    await Job.insertMany(
      due.map(({ lead, runAt }) => ({
        type: 'announcement.reminder',
        runAt,
        refId: announcement._id,
        userId,
        practiceId,
        data: { lead },
      })),
    );
  }
  return due.length;
};

/** Cancel what has not run yet: one person's, or with no user, everyone's on this announcement. */
export const cancelReminders = async (announcementId: Types.ObjectId, userId?: Types.ObjectId): Promise<number> => {
  const result = await Job.updateMany(
    { refId: announcementId, type: 'announcement.reminder', status: 'pending', ...(userId ? { userId } : {}) },
    { $set: { status: 'cancelled' } },
  );
  return result.modifiedCount;
};

/**
 * After an edit that moved the start, or took the date away: everyone's
 * pending reminders are cancelled and, while it still has a date, scheduled
 * again for the new time.
 */
export const rescheduleReminders = async (announcement: AnnouncementDoc, now: Date = new Date()): Promise<void> => {
  await cancelReminders(announcement._id);
  if (!announcement.event) {
    return;
  }
  const reminded = await AnnouncementState.find({
    announcementId: announcement._id,
    remindedAt: { $ne: null },
    remindedPracticeId: { $ne: null },
  });
  await Promise.all(reminded.map((state) => scheduleReminders(announcement, state.userId, state.remindedPracticeId!, now)));
};

/**
 * One due reminder. Skipped, not sent, when the announcement is no longer
 * published, the event has started, or the person has left the clinic whose
 * bell it would go to.
 */
export const runReminder = async (job: JobDoc, now: Date): Promise<'done' | 'skipped'> => {
  const announcement = await Announcement.findById(job.refId);
  if (!announcement || announcement.status !== 'published' || !announcement.event || announcement.event.startsAt <= now) {
    return 'skipped';
  }
  if (!job.userId || !job.practiceId) {
    return 'skipped';
  }
  const member = await Membership.exists({ userId: job.userId, practiceId: job.practiceId, status: 'active' });
  if (!member) {
    return 'skipped';
  }
  emit('announcement.reminderDue', {
    announcementId: announcement._id,
    practiceId: job.practiceId,
    userId: job.userId,
    lead: (job.data.lead as Lead) ?? 'hour',
    title: announcement.title,
    startsAt: announcement.event.startsAt,
    place: announcement.event.place,
  });
  return 'done';
};

export default { scheduleReminders, cancelReminders, rescheduleReminders, runReminder };
