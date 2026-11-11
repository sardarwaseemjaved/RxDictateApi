import { Types } from 'mongoose';
import {
  Announcement,
  AnnouncementRegistration,
  AnnouncementState,
  Practice,
  User,
  type AnnouncementDoc,
  type AnnouncementStateDoc,
} from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import type { Scope } from '../core/db';
import {
  ANNOUNCEMENT_PLACEMENT_LIMITS,
  DATED_KINDS,
  type AnnouncementEventType,
  type AnnouncementPlacement,
  type AnnouncementSlotView,
  type AnnouncementStateView,
} from '../shared/announcement.schema';
import { settingFor } from './settings.service';
import { matchesAudience, memberFor } from './announcementAudience.service';
import { eventOf, imageOf, isSponsored, productOf, referencesFor, sponsorOf, type References } from './announcement.service';
import { cancelReminders, scheduleReminders } from './announcementReminder.service';

type Audited = Scope & { requestId?: string | null };

/**
 * Announcements as a clinic member meets them: what a slot shows, what their
 * app reports back, and reminding themselves or registering.
 *
 * What a slot shows is decided here and only here: published, inside its
 * window, for this member's audience, not dismissed, under its cap, and - when
 * the member's `announcements.sponsored` setting is off - not sponsored. In
 * order of priority, then newest. Nothing here is ever used by the consult,
 * the printout, the patient's portal or medicine search.
 */

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number }).code === 11000;

/** This person's state on one, made the first time it is needed. */
const stateFor = async (announcementId: Types.ObjectId, userId: Types.ObjectId): Promise<AnnouncementStateDoc> => {
  const upsert = () =>
    AnnouncementState.findOneAndUpdate(
      { announcementId, userId },
      { $setOnInsert: { announcementId, userId } },
      { upsert: true, new: true },
    );
  try {
    return (await upsert())!;
  } catch (error) {
    // Two first events at once: the other one made it.
    if (isDuplicateKey(error)) {
      return (await upsert())!;
    }
    throw error;
  }
};

const toStateView = (state: AnnouncementStateDoc | null, registered: boolean): AnnouncementStateView => ({
  shows: state?.shows ?? 0,
  dismissed: Boolean(state?.dismissedAt),
  reminded: Boolean(state?.remindedAt),
  registered,
});

/**
 * Whether a published announcement may show at all, apart from who is
 * looking: a suspended sponsor's items stop, and a product whose medicine is
 * no longer active stops.
 */
const stillShowable = (announcement: AnnouncementDoc, references: References): boolean => {
  if (announcement.sponsorId && references.sponsors.get(String(announcement.sponsorId))?.suspended !== false) {
    return false;
  }
  if (announcement.kind === 'product') {
    return references.products.get(String(announcement.drugId))?.active === true;
  }
  return true;
};

/** `GET /announcements/slots?placement=…`: what this member sees there now, in order. */
export const slotsFor = async (
  scope: Scope,
  placement: AnnouncementPlacement,
  now: Date = new Date(),
): Promise<AnnouncementSlotView[]> => {
  const candidates = await Announcement.find({
    status: 'published',
    placements: placement,
    showFrom: { $lte: now },
    showUntil: { $gt: now },
  }).sort({ priority: -1, publishedAt: -1, _id: -1 });
  if (candidates.length === 0) {
    return [];
  }

  const ids = candidates.map((announcement) => announcement._id);
  const [member, sponsoredOn, states, registrations, references] = await Promise.all([
    memberFor(scope),
    settingFor(scope, 'announcements.sponsored'),
    AnnouncementState.find({ userId: scope.actorId, announcementId: { $in: ids } }),
    AnnouncementRegistration.find({ userId: scope.actorId, announcementId: { $in: ids } }).select('announcementId'),
    referencesFor(candidates),
  ]);
  const stateOf = new Map(states.map((state) => [String(state.announcementId), state]));
  const registered = new Set(registrations.map((registration) => String(registration.announcementId)));

  const shown = candidates.filter((announcement) => {
    const state = stateOf.get(String(announcement._id));
    return (
      matchesAudience(announcement.audience, member) &&
      (sponsoredOn || !isSponsored(announcement)) &&
      stillShowable(announcement, references) &&
      !state?.dismissedAt &&
      (announcement.maxShows === null || (state?.shows ?? 0) < announcement.maxShows)
    );
  });
  const limit = ANNOUNCEMENT_PLACEMENT_LIMITS[placement];

  return Promise.all(
    (limit === null ? shown : shown.slice(0, limit)).map(async (announcement) => ({
      id: String(announcement._id),
      kind: announcement.kind,
      title: announcement.title,
      body: announcement.body,
      image: await imageOf(announcement.imageKey),
      link: announcement.link,
      cta: announcement.cta,
      event: eventOf(announcement),
      sponsor: sponsorOf(announcement, references),
      isSponsored: isSponsored(announcement),
      product: productOf(announcement, references),
      showUntil: announcement.showUntil,
      reminded: Boolean(stateOf.get(String(announcement._id))?.remindedAt),
      registered: registered.has(String(announcement._id)),
    })),
  );
};

/**
 * A published announcement this member is in the audience of. A draft, or
 * one meant for others, is NOT_FOUND: whether it exists is not theirs to know.
 */
const reachable = async (scope: Scope, id: string): Promise<AnnouncementDoc> => {
  const announcement = Types.ObjectId.isValid(id) ? await Announcement.findById(id) : null;
  if (!announcement || announcement.status === 'draft' || !matchesAudience(announcement.audience, await memberFor(scope))) {
    throw AppError.notFound('Announcement');
  }
  if (announcement.status === 'withdrawn') {
    throw new AppError('ANNOUNCEMENT_WITHDRAWN', 'RxDictate has withdrawn this.');
  }
  return announcement;
};

/**
 * One a member may still remind themselves of or register for: a seminar or
 * an event, published, inside its window, and not yet started.
 */
const upcomingEvent = async (scope: Scope, id: string, now: Date): Promise<AnnouncementDoc> => {
  const announcement = await reachable(scope, id);
  if (!DATED_KINDS.includes(announcement.kind) || !announcement.event) {
    throw new AppError('ANNOUNCEMENT_NOT_AN_EVENT', 'Only a seminar or an event takes a reminder or a registration.');
  }
  if (announcement.showUntil <= now || announcement.event.startsAt <= now) {
    throw new AppError('ANNOUNCEMENT_ENDED', 'This has already started or ended.');
  }
  return announcement;
};

const isRegistered = async (announcementId: Types.ObjectId, userId: Types.ObjectId): Promise<boolean> =>
  Boolean(await AnnouncementRegistration.exists({ announcementId, userId }));

/**
 * `POST /announcements/:id/events`. `shown` is what the cap counts, so an app
 * sends it when it actually draws one. Totals go on the announcement; who saw
 * it stays in this person's own state.
 */
export const recordEvent = async (scope: Scope, id: string, type: AnnouncementEventType): Promise<AnnouncementStateView> => {
  const announcement = await reachable(scope, id);
  let state = await stateFor(announcement._id, scope.actorId);
  if (type === 'shown') {
    state = (await AnnouncementState.findByIdAndUpdate(state._id, { $inc: { shows: 1 } }, { new: true }))!;
    await Announcement.updateOne({ _id: announcement._id }, { $inc: { 'stats.shows': 1 } });
  } else if (type === 'clicked') {
    await Announcement.updateOne({ _id: announcement._id }, { $inc: { 'stats.clicks': 1 } });
  } else if (!state.dismissedAt) {
    state = (await AnnouncementState.findByIdAndUpdate(state._id, { $set: { dismissedAt: new Date() } }, { new: true }))!;
  }
  return toStateView(state, await isRegistered(announcement._id, scope.actorId));
};

/**
 * `POST /announcements/:id/reminder`: a bell notification a day before and an
 * hour before it starts, skipping a time already past. Asking twice changes
 * nothing.
 */
export const setReminder = async (scope: Audited, id: string, now: Date = new Date()): Promise<AnnouncementStateView> => {
  const announcement = await upcomingEvent(scope, id, now);
  await stateFor(announcement._id, scope.actorId);
  const state = await AnnouncementState.findOneAndUpdate(
    { announcementId: announcement._id, userId: scope.actorId, remindedAt: null },
    { $set: { remindedAt: now, remindedPracticeId: scope.practiceId } },
    { new: true },
  );
  if (state) {
    const scheduled = await scheduleReminders(announcement, scope.actorId, scope.practiceId, now);
    await writeAudit(scope, {
      action: 'announcement.reminder.set',
      entity: 'announcement',
      entityId: announcement._id,
      after: { reminders: scheduled },
      requestId: scope.requestId ?? null,
    });
  }
  const current = await AnnouncementState.findOne({ announcementId: announcement._id, userId: scope.actorId });
  return toStateView(current, await isRegistered(announcement._id, scope.actorId));
};

/** `DELETE /announcements/:id/reminder`: cancel what has not been sent. Allowed whatever state the announcement is in. */
export const cancelReminder = async (scope: Audited, id: string): Promise<AnnouncementStateView> => {
  const announcement = Types.ObjectId.isValid(id) ? await Announcement.findById(id) : null;
  if (!announcement || announcement.status === 'draft') {
    throw AppError.notFound('Announcement');
  }
  const state = await AnnouncementState.findOneAndUpdate(
    { announcementId: announcement._id, userId: scope.actorId, remindedAt: { $ne: null } },
    { $set: { remindedAt: null, remindedPracticeId: null } },
    { new: true },
  );
  if (state) {
    const cancelled = await cancelReminders(announcement._id, scope.actorId);
    await writeAudit(scope, {
      action: 'announcement.reminder.cancel',
      entity: 'announcement',
      entityId: announcement._id,
      after: { cancelled },
      requestId: scope.requestId ?? null,
    });
  }
  const current = state ?? (await AnnouncementState.findOne({ announcementId: announcement._id, userId: scope.actorId }));
  return toStateView(current, await isRegistered(announcement._id, scope.actorId));
};

/**
 * `POST /announcements/:id/register`, with consent: their name, phone and
 * clinic as they are now, for the organiser. Registering twice changes nothing.
 */
export const register = async (scope: Audited, id: string, now: Date = new Date()): Promise<AnnouncementStateView> => {
  const announcement = await upcomingEvent(scope, id, now);
  const existing = await AnnouncementRegistration.exists({ announcementId: announcement._id, userId: scope.actorId });
  if (!existing) {
    const [user, clinic] = await Promise.all([User.findById(scope.actorId), Practice.findById(scope.practiceId)]);
    try {
      await AnnouncementRegistration.create({
        announcementId: announcement._id,
        userId: scope.actorId,
        practiceId: scope.practiceId,
        name: user?.name ?? '',
        phone: user!.phone,
        clinicName: clinic?.name ?? '',
        consentAt: now,
      });
      // Who registered is the organiser's list; the audit records that it happened, not their details.
      await writeAudit(scope, {
        action: 'announcement.register',
        entity: 'announcement',
        entityId: announcement._id,
        after: { consent: true },
        requestId: scope.requestId ?? null,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }
    }
  }
  const state = await AnnouncementState.findOne({ announcementId: announcement._id, userId: scope.actorId });
  return toStateView(state, true);
};

/** `DELETE /announcements/:id/register`: consent taken back, so their details are deleted. */
export const unregister = async (scope: Audited, id: string): Promise<AnnouncementStateView> => {
  const announcement = Types.ObjectId.isValid(id) ? await Announcement.findById(id) : null;
  if (!announcement || announcement.status === 'draft') {
    throw AppError.notFound('Announcement');
  }
  const { deletedCount } = await AnnouncementRegistration.deleteOne({
    announcementId: announcement._id,
    userId: scope.actorId,
  });
  if (deletedCount > 0) {
    await writeAudit(scope, {
      action: 'announcement.unregister',
      entity: 'announcement',
      entityId: announcement._id,
      after: { consent: false },
      requestId: scope.requestId ?? null,
    });
  }
  const state = await AnnouncementState.findOne({ announcementId: announcement._id, userId: scope.actorId });
  return toStateView(state, false);
};

export default { slotsFor, recordEvent, setReminder, cancelReminder, register, unregister };
