import type { Types } from 'mongoose';
import { Announcement, Counter, Practice, type IAnnouncementAudience, type PracticeDoc } from '../models';
import { AppError } from '../core/errors';
import type { AnnouncementAllowance, AnnouncementAllowanceView, AnnouncementAudience } from '../shared/announcement.schema';
import { karachiMonth, karachiMonthRange } from '../utils/time';
import { countAudience } from './announcementAudience.service';

/**
 * A company's announcement allowance: how many it may publish in a month, and
 * how many people each may reach. RxDictate sets both by hand on the company;
 * null is no limit, and every company starts with none.
 *
 * What counts is an announcement with the company as sponsor, in the
 * Asia/Karachi month it was first published, whoever wrote it. A draft does
 * not count; one withdrawn after publishing still does. `publishedAt` is set
 * once and never moves (announcement.model), so it is the first publish.
 *
 * Two publishes at once for one company must not both get the last post, so
 * each takes one from a counter per company and month first, with a
 * conditional $inc that only one of them can win, and gives it back if the
 * publish then fails. The counter is made the first time a month needs it,
 * from the announcements already published in it, so posts published before
 * allowances existed are counted too.
 */

const DUPLICATE_KEY = 11000;

const keyOf = (month: string): string => `announcementPosts:${month}`;

export const allowanceOf = (company: Pick<PracticeDoc, 'announcementAllowance'>): AnnouncementAllowance => ({
  postsPerMonth: company.announcementAllowance?.postsPerMonth ?? null,
  peoplePerPost: company.announcementAllowance?.peoplePerPost ?? null,
});

/** Published in that month with this sponsor, counted from the announcements themselves. */
const countPublished = async (companyId: Types.ObjectId, month: string): Promise<number> => {
  const { start, end } = karachiMonthRange(month);
  return Announcement.countDocuments({ sponsorId: companyId, publishedAt: { $gte: start, $lt: end } });
};

/** The month's counter, made from what is already published the first time it is needed. */
const ensureCounter = async (companyId: Types.ObjectId, month: string): Promise<void> => {
  const key = keyOf(month);
  if (await Counter.exists({ practiceId: companyId, key })) {
    return;
  }
  const used = await countPublished(companyId, month);
  try {
    await Counter.create({ practiceId: companyId, key, seq: used });
  } catch (error) {
    // Two first publishes of the month at once: the other one made it, from the same count.
    if ((error as { code?: number }).code !== DUPLICATE_KEY) {
      throw error;
    }
  }
};

/** Posts that count against a month so far. */
export const usedIn = async (companyId: Types.ObjectId, month: string): Promise<number> => {
  const counter = await Counter.findOne({ practiceId: companyId, key: keyOf(month) }).select('seq');
  return counter ? counter.seq : countPublished(companyId, month);
};

export const allowanceViewOf = async (
  company: Pick<PracticeDoc, '_id' | 'announcementAllowance'>,
  now: Date = new Date(),
): Promise<AnnouncementAllowanceView> => {
  const month = karachiMonth(now);
  return { ...allowanceOf(company), usedThisMonth: await usedIn(company._id, month), month };
};

/** The allowance of the company with this id, or null when it is not a company. */
export const allowanceViewFor = async (
  companyId: Types.ObjectId,
  now: Date = new Date(),
): Promise<AnnouncementAllowanceView | null> => {
  const company = await Practice.findOne({ _id: companyId, type: 'company' }).select('announcementAllowance');
  return company ? allowanceViewOf(company, now) : null;
};

/**
 * Take one of a month's posts, or refuse with ANNOUNCEMENT_ALLOWANCE_USED.
 * With no limit it is still counted, so the count is right if one is set later.
 */
export const claimPost = async (companyId: Types.ObjectId, month: string, allowed: number | null): Promise<void> => {
  await ensureCounter(companyId, month);
  const key = keyOf(month);
  const claimed = await Counter.findOneAndUpdate(
    { practiceId: companyId, key, ...(allowed === null ? {} : { seq: { $lt: allowed } }) },
    { $inc: { seq: 1 } },
    { new: true },
  );
  if (!claimed) {
    const used = (await Counter.findOne({ practiceId: companyId, key }).select('seq'))?.seq ?? allowed ?? 0;
    throw new AppError(
      'ANNOUNCEMENT_ALLOWANCE_USED',
      `This company has published ${used} of the ${allowed} announcements its allowance gives it in ${month}.`,
      { used, allowed, month },
    );
  }
};

/**
 * Give a post back: a publish that failed after taking one, or a published
 * one moved to another sponsor. With no counter yet, the month is counted
 * afresh from what is published now, which already leaves it out.
 */
export const releasePost = async (companyId: Types.ObjectId, month: string): Promise<void> => {
  const released = await Counter.findOneAndUpdate(
    { practiceId: companyId, key: keyOf(month), seq: { $gt: 0 } },
    { $inc: { seq: -1 } },
  );
  if (!released) {
    await ensureCounter(companyId, month);
  }
};

/** Refuse with ANNOUNCEMENT_REACH_OVER_ALLOWANCE when the audience reaches more people than one post may. */
export const assertReach = async (
  allowance: AnnouncementAllowance,
  audience: AnnouncementAudience | IAnnouncementAudience,
): Promise<void> => {
  if (allowance.peoplePerPost === null) {
    return;
  }
  const reach = await countAudience(audience);
  if (reach > allowance.peoplePerPost) {
    throw new AppError(
      'ANNOUNCEMENT_REACH_OVER_ALLOWANCE',
      `This audience reaches ${reach} people; the sponsor's allowance lets one announcement reach ${allowance.peoplePerPost}.`,
      { reach, allowed: allowance.peoplePerPost },
    );
  }
};

export default { allowanceOf, allowanceViewOf, allowanceViewFor, usedIn, claimPost, releasePost, assertReach };
