import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import {
  Announcement,
  AnnouncementRegistration,
  AnnouncementState,
  Drug,
  Practice,
  User,
  normaliseName,
  type AnnouncementDoc,
  type AnnouncementRegistrationDoc,
  type IAnnouncement,
  type IDrug,
} from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { Scope } from '../core/db';
import {
  announcementImageKey,
  announcementImagePrefix,
  isIssuedAnnouncementImageKey,
  reportExtensionFor,
  signedGetUrl,
  signedPutUrl,
} from '../core/storage';
import type { PageMeta } from '../shared/response';
import type { UploadTicket } from '../shared/report.schema';
import {
  announcementSchema,
  type AnnouncementAudience,
  type AnnouncementForPersonView,
  type AnnouncementPeopleQuery,
  type AnnouncementPersonView,
  type AnnouncementProductView,
  type AnnouncementReachQuery,
  type AnnouncementReachRow,
  type AnnouncementRegistrationView,
  type AnnouncementStatsView,
  type AnnouncementStep,
  type AnnouncementView,
  type CompanyAnnouncementPayload,
  type CreateAnnouncementBody,
  type CreateAnnouncementImageBody,
  type ListAnnouncementRegistrationsQuery,
  type ListAnnouncementsQuery,
  type SearchAnnouncementProductsQuery,
  type UpdateAnnouncementBody,
} from '../shared/announcement.schema';
import { toCsv } from '../utils/csv';
import { karachiClock, karachiDay, karachiMonth } from '../utils/time';
import { nationalRows, prefixOf } from './drugAccess.service';
import { countAudience, matchesAudience, membersOf } from './announcementAudience.service';
import { cancelReminders, rescheduleReminders } from './announcementReminder.service';
import { peopleByIds, searchPeople as findPeople } from './announcementPeople.service';
import { allowanceOf, assertReach, claimPost, releasePost } from './announcementAllowance.service';

type Audited = Scope & { requestId?: string | null };

/**
 * Announcements, as RxDictate's console writes and publishes them.
 *
 * RxDictate's team writes them, sponsored ones included, and a company's own
 * arrive as drafts approved from the review queue (createFromSubmission).
 * Either way only the console publishes, so RxDictate is its own reviewer: a
 * published one may be edited, and every step is kept in its history and the
 * audit log. A sponsor's allowance is checked when one is published, and
 * when a published one's audience or sponsor changes. What a clinic member
 * sees, and what they do with it, is announcementSlot.service.
 */

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export const isSponsored = (announcement: Pick<IAnnouncement, 'sponsorId' | 'kind'>): boolean =>
  announcement.sponsorId !== null || announcement.kind === 'product';

export const hasEnded = (announcement: Pick<IAnnouncement, 'showUntil'>, now: Date = new Date()): boolean =>
  announcement.showUntil <= now;

/** The sponsors and products a page of announcements names, in two queries. */
export interface References {
  sponsors: Map<string, { id: string; name: string; suspended: boolean }>;
  products: Map<string, { id: string; brand: string; strength: string; active: boolean }>;
}

export const referencesFor = async (announcements: AnnouncementDoc[]): Promise<References> => {
  const sponsorIds = [...new Set(announcements.flatMap((one) => (one.sponsorId ? [String(one.sponsorId)] : [])))];
  const drugIds = [...new Set(announcements.flatMap((one) => (one.drugId ? [String(one.drugId)] : [])))];
  const [sponsors, drugs] = await Promise.all([
    sponsorIds.length > 0 ? Practice.find({ _id: { $in: sponsorIds } }).select('name status') : Promise.resolve([]),
    drugIds.length > 0 ? Drug.find({ _id: { $in: drugIds } }).select('brand strength status') : Promise.resolve([]),
  ]);
  return {
    sponsors: new Map(
      sponsors.map((sponsor) => [
        String(sponsor._id),
        { id: String(sponsor._id), name: sponsor.name, suspended: sponsor.status === 'suspended' },
      ]),
    ),
    products: new Map(
      drugs.map((drug) => [
        String(drug._id),
        { id: String(drug._id), brand: drug.brand, strength: drug.strength, active: drug.status === 'active' },
      ]),
    ),
  };
};

export const sponsorOf = (announcement: AnnouncementDoc, references: References) => {
  const sponsor = announcement.sponsorId ? references.sponsors.get(String(announcement.sponsorId)) : undefined;
  return sponsor ? { id: sponsor.id, name: sponsor.name } : null;
};

export const productOf = (announcement: AnnouncementDoc, references: References) => {
  const product = announcement.drugId ? references.products.get(String(announcement.drugId)) : undefined;
  return product ? { id: product.id, brand: product.brand, strength: product.strength } : null;
};

/** A link to the image good for the usual signed-URL lifetime, or null for none. */
export const imageOf = async (key: string | null): Promise<{ url: string; expiresAt: Date } | null> => {
  if (!key) {
    return null;
  }
  const signed = await signedGetUrl(key);
  return { url: signed.url, expiresAt: signed.expiresAt };
};

export const eventOf = (announcement: AnnouncementDoc): AnnouncementView['event'] =>
  announcement.event
    ? {
        startsAt: announcement.event.startsAt,
        endsAt: announcement.event.endsAt ?? null,
        place: announcement.event.place ?? null,
        onlineUrl: announcement.event.onlineUrl ?? null,
      }
    : null;

const toView = async (
  announcement: AnnouncementDoc,
  references: References,
  people: Map<string, AnnouncementPersonView>,
  forPerson: AnnouncementForPersonView | null = null,
): Promise<AnnouncementView> => ({
  id: String(announcement._id),
  kind: announcement.kind,
  title: announcement.title,
  body: announcement.body,
  imageKey: announcement.imageKey,
  image: await imageOf(announcement.imageKey),
  link: announcement.link,
  cta: announcement.cta,
  event: eventOf(announcement),
  drugId: announcement.drugId ? String(announcement.drugId) : null,
  product: productOf(announcement, references),
  sponsor: sponsorOf(announcement, references),
  isSponsored: isSponsored(announcement),
  showFrom: announcement.showFrom,
  showUntil: announcement.showUntil,
  audience: {
    roles: [...announcement.audience.roles],
    specialties: [...announcement.audience.specialties],
    provinces: [...announcement.audience.provinces],
    cities: [...announcement.audience.cities],
    organisationIds: announcement.audience.organisationIds.map(String),
    userIds: announcement.audience.userIds.map(String),
  },
  people: announcement.audience.userIds.flatMap((id) => {
    const person = people.get(String(id));
    return person ? [person] : [];
  }),
  placements: [...announcement.placements],
  priority: announcement.priority,
  maxShows: announcement.maxShows,
  status: announcement.status,
  ended: announcement.status === 'published' && hasEnded(announcement),
  publishedAt: announcement.publishedAt,
  withdrawnAt: announcement.withdrawnAt,
  history: announcement.history.map((entry) => ({
    step: entry.step,
    at: entry.at,
    by: String(entry.by),
    fields: [...entry.fields],
  })),
  submissionId: announcement.submissionId ? String(announcement.submissionId) : null,
  forPerson,
  createdBy: String(announcement.createdBy),
  createdAt: announcement.createdAt,
  updatedAt: announcement.updatedAt,
});

/** Views of a page: one query each for sponsors, products and the people the audiences name. */
const viewsOf = async (
  announcements: AnnouncementDoc[],
  forPerson?: Map<string, AnnouncementForPersonView>,
): Promise<AnnouncementView[]> => {
  const [references, people] = await Promise.all([
    referencesFor(announcements),
    peopleByIds(announcements.flatMap((announcement) => announcement.audience.userIds)),
  ]);
  return Promise.all(
    announcements.map((announcement) =>
      toView(announcement, references, people, forPerson?.get(String(announcement._id)) ?? null),
    ),
  );
};

const viewOf = async (announcement: AnnouncementDoc): Promise<AnnouncementView> => (await viewsOf([announcement]))[0];

export const findAnnouncement = async (id: string): Promise<AnnouncementDoc> => {
  const announcement = Types.ObjectId.isValid(id) ? await Announcement.findById(id) : null;
  if (!announcement) {
    throw AppError.notFound('Announcement');
  }
  return announcement;
};

const sponsorFilter = (sponsorId: string) => ({
  sponsorId: sponsorId === 'none' ? null : new Types.ObjectId(sponsorId),
});

const pageMeta = (page: number, limit: number, total: number): PageMeta => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});

const isLive = (announcement: AnnouncementDoc, now: Date): boolean =>
  announcement.status === 'published' && announcement.showFrom <= now && announcement.showUntil > now;

/**
 * `GET /announcements?userId=`: what one person is in the audience of now -
 * published, inside its window, and matching them through any clinic they
 * are active in - and anything they have a state on (shown, dismissed,
 * reminded) or registered for, whatever its status. Each row carries their
 * own record of it. Audited, query and all.
 *
 * Reads every announcement the other filters leave and works it out in
 * memory, as countAudience does: fine at this scale, where announcements are
 * counted in hundreds.
 */
const listForPerson = async (
  scope: Audited,
  query: ListAnnouncementsQuery & { userId: string },
  now: Date = new Date(),
): Promise<{ announcements: AnnouncementView[]; meta: PageMeta }> => {
  const userId = new Types.ObjectId(query.userId);
  if (!(await User.exists({ _id: userId }))) {
    throw AppError.notFound('Person');
  }
  const [members, candidates, states, registrations] = await Promise.all([
    membersOf(userId),
    Announcement.find({
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.sponsorId ? sponsorFilter(query.sponsorId) : {}),
    }).sort({ createdAt: -1, _id: -1 }),
    AnnouncementState.find({ userId }),
    AnnouncementRegistration.find({ userId }).select('announcementId'),
  ]);
  const stateOf = new Map(states.map((state) => [String(state.announcementId), state]));
  const registered = new Set(registrations.map((registration) => String(registration.announcementId)));

  const records = new Map<string, AnnouncementForPersonView>();
  const rows = candidates.filter((announcement) => {
    const id = String(announcement._id);
    const state = stateOf.get(id);
    const inAudience = members.some((member) => matchesAudience(announcement.audience, member));
    if (!state && !registered.has(id) && !(inAudience && isLive(announcement, now))) {
      return false;
    }
    records.set(id, {
      inAudience,
      shows: state?.shows ?? 0,
      clicks: state?.clicks ?? 0,
      dismissed: Boolean(state?.dismissedAt),
      reminded: Boolean(state?.remindedAt),
      registered: registered.has(id),
      firstShownAt: state?.firstShownAt ?? null,
      lastShownAt: state?.lastShownAt ?? null,
    });
    return true;
  });

  await writeAudit(scope, {
    action: 'announcement.people.read',
    entity: 'user',
    entityId: userId,
    after: { query },
    requestId: scope.requestId ?? null,
  });

  const start = (query.page - 1) * query.limit;
  return {
    announcements: await viewsOf(rows.slice(start, start + query.limit), records),
    meta: pageMeta(query.page, query.limit, rows.length),
  };
};

/** `GET /announcements`: newest first. With `userId`, one person's record of each (listForPerson). */
export const listAnnouncements = async (
  scope: Audited,
  query: ListAnnouncementsQuery,
): Promise<{ announcements: AnnouncementView[]; meta: PageMeta }> => {
  if (query.userId) {
    return listForPerson(scope, { ...query, userId: query.userId });
  }
  const result = await Announcement.paginate(
    {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.sponsorId ? sponsorFilter(query.sponsorId) : {}),
    },
    { page: query.page, limit: query.limit, sortBy: 'createdAt:desc,_id:desc' },
  );
  return {
    announcements: await viewsOf(result.results),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

/** `GET /announcements/people`: clinic members to choose for an audience. */
export const searchPeople = async (query: AnnouncementPeopleQuery): Promise<AnnouncementPersonView[]> => findPeople(query);

interface ReachGroup {
  _id: Types.ObjectId;
  announcements: number;
  shows: number;
  clicks: number;
  dismissed: number;
  lastShownAt: Date | null;
}

/**
 * `GET /announcements/reach`: one row per person shown at least one of a
 * sponsor's announcements, or one announcement, most shows first. One
 * aggregation over announcementStates, which the (announcementId, userId)
 * index serves. Audited, query and all.
 */
export const reach = async (
  scope: Audited,
  query: AnnouncementReachQuery,
): Promise<{ rows: AnnouncementReachRow[]; meta: PageMeta }> => {
  let announcementIds: Types.ObjectId[];
  if (query.announcementId) {
    announcementIds = [(await findAnnouncement(query.announcementId))._id];
  } else {
    announcementIds = (await Announcement.find(sponsorFilter(query.sponsorId!)).select('_id')).map((one) => one._id);
  }

  const [result] = await AnnouncementState.aggregate<{ rows: ReachGroup[]; total: { count: number }[] }>([
    { $match: { announcementId: { $in: announcementIds }, shows: { $gt: 0 } } },
    {
      $group: {
        _id: '$userId',
        announcements: { $sum: 1 },
        shows: { $sum: '$shows' },
        clicks: { $sum: { $ifNull: ['$clicks', 0] } },
        dismissed: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$dismissedAt', null] }, null] }, 1, 0] } },
        lastShownAt: { $max: '$lastShownAt' },
      },
    },
    { $sort: { shows: -1, _id: 1 } },
    {
      $facet: {
        rows: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  await writeAudit(scope, {
    action: 'announcement.people.read',
    entity: 'announcement',
    entityId: query.announcementId ? announcementIds[0] : null,
    after: { query },
    requestId: scope.requestId ?? null,
  });

  const groups = result?.rows ?? [];
  const people = await peopleByIds(groups.map((group) => group._id));
  const rows = groups.flatMap((group) => {
    const person = people.get(String(group._id));
    return person
      ? [
          {
            person,
            announcements: group.announcements,
            shows: group.shows,
            clicks: group.clicks,
            dismissed: group.dismissed,
            lastShownAt: group.lastShownAt ?? null,
          },
        ]
      : [];
  });
  return { rows, meta: pageMeta(query.page, query.limit, result?.total[0]?.count ?? 0) };
};

export const getAnnouncement = async (id: string): Promise<AnnouncementView> => viewOf(await findAnnouncement(id));

/** Active national products only: no clinic scope, lists, usage or settings. */
export const searchProducts = async (query: SearchAnnouncementProductsQuery): Promise<AnnouncementProductView[]> => {
  const typed = normaliseName(query.q);
  const prefix = prefixOf(typed).source;
  const contains = prefix.slice(1);
  const fields = ['brand', 'generic', 'drapRegNo'];
  const drugs = await Drug.aggregate<IDrug & { _id: Types.ObjectId }>([
    {
      $match: {
        ...nationalRows,
        status: 'active',
        ...(query.sponsorId ? { companyId: new Types.ObjectId(query.sponsorId) } : {}),
        ...(typed ? { $or: fields.map((field) => ({ [field]: { $regex: contains, $options: 'i' } })) } : {}),
      },
    },
    {
      $set: {
        rank: {
          $switch: {
            branches: [
              { case: { $eq: ['$brandKey', typed] }, then: 0 },
              {
                case: {
                  $or: fields.map((field) => ({
                    $regexMatch: { input: { $ifNull: [`$${field}`, ''] }, regex: prefix, options: 'i' },
                  })),
                },
                then: 1,
              },
            ],
            default: 2,
          },
        },
      },
    },
    { $sort: { rank: 1, brandKey: 1, strength: 1, _id: 1 } },
    { $limit: query.limit },
  ]);
  const companyIds = [...new Set(drugs.flatMap((drug) => (drug.companyId ? [String(drug.companyId)] : [])))];
  const companies = new Map(
    (companyIds.length ? await Practice.find({ _id: { $in: companyIds }, type: 'company' }).select('name') : []).map(
      (company) => [String(company._id), { id: String(company._id), name: company.name }],
    ),
  );
  return drugs.map((drug) => ({
    id: String(drug._id),
    brand: drug.brand,
    strength: drug.strength,
    form: drug.form,
    composition: drug.generic,
    registrationNo: drug.drapRegNo,
    company: drug.companyId ? (companies.get(String(drug.companyId)) ?? null) : null,
  }));
};

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

/** A VALIDATION_ERROR on one field, named by its whole path: `body.drugId`, `body.payload.imageKey`. */
export const invalidAt = (field: string, message: string): AppError =>
  new AppError('VALIDATION_ERROR', `${field}: ${message}`, [{ field, message }]);

const invalid = (field: string, message: string): AppError => invalidAt(`body.${field}`, message);

/**
 * A product its sponsor may promote: an active national medicine the sponsor
 * owns, one it added or claimed. An unclaimed DRAP row must be claimed first.
 */
export const checkSponsorProduct = async (
  drugId: string,
  sponsorId: string | null,
  field = 'body.drugId',
): Promise<void> => {
  const drug = await Drug.findOne({ ...nationalRows, _id: drugId, status: 'active' }).select('companyId');
  if (!drug) {
    throw invalidAt(field, 'is not an active national medicine');
  }
  if (!drug.companyId || String(drug.companyId) !== sponsorId) {
    throw invalidAt(field, 'must be a product owned by the sponsor; unclaimed medicines must be claimed first');
  }
};

/** Whether an image key was handed out by POST /announcements/images to this organisation. */
export const isImageOf = (organisationId: Types.ObjectId | string, key: string): boolean =>
  isIssuedAnnouncementImageKey(announcementImagePrefix(organisationId), key);

const wrongStatus = (announcement: AnnouncementDoc, wanted: string): AppError =>
  new AppError('ANNOUNCEMENT_WRONG_STATUS', `This announcement is ${announcement.status}; ${wanted}.`, {
    status: announcement.status,
  });

/**
 * What an announcement names must exist and be the right kind of thing: an
 * image this console or the sponsor uploaded, a company as sponsor, an
 * active national medicine as the product, clinics as organisations.
 *
 * An image key carries the organisation that uploaded it, so a company's
 * picture is accepted on an announcement it sponsors - the draft its
 * submission became - and on no one else's.
 */
const checkReferences = async (scope: Scope, fields: CreateAnnouncementBody): Promise<void> => {
  if (
    fields.imageKey &&
    !isImageOf(scope.practiceId, fields.imageKey) &&
    !(fields.sponsorId && isImageOf(fields.sponsorId, fields.imageKey))
  ) {
    throw invalid('imageKey', 'was not uploaded through POST /announcements/images by RxDictate or the sponsor');
  }
  if (fields.sponsorId) {
    const sponsor = await Practice.exists({ _id: fields.sponsorId, type: 'company', deletedAt: null });
    if (!sponsor) {
      throw invalid('sponsorId', 'is not a company');
    }
  }
  if (fields.drugId) {
    // The rules allow a drugId on a product only, which always has a sponsor.
    await checkSponsorProduct(fields.drugId, fields.sponsorId);
  }
  const { organisationIds, userIds } = fields.audience;
  if (organisationIds.length > 0) {
    const clinics = await Practice.countDocuments({ _id: { $in: organisationIds }, type: 'clinic', deletedAt: null });
    if (clinics !== new Set(organisationIds).size) {
      throw invalid('audience.organisationIds', 'must all be clinics');
    }
  }
  if (userIds.length > 0) {
    const users = await User.countDocuments({ _id: { $in: userIds } });
    if (users !== new Set(userIds).size) {
      throw invalid('audience.userIds', 'names somebody who does not exist');
    }
  }
};

/** The stored announcement in the shape of a request body, so an edit can be checked as the whole it makes. */
const asBody = (announcement: AnnouncementDoc): Record<string, unknown> => ({
  kind: announcement.kind,
  title: announcement.title,
  body: announcement.body,
  imageKey: announcement.imageKey,
  link: announcement.link,
  cta: announcement.cta,
  event: eventOf(announcement),
  drugId: announcement.drugId ? String(announcement.drugId) : null,
  sponsorId: announcement.sponsorId ? String(announcement.sponsorId) : null,
  showFrom: announcement.showFrom,
  showUntil: announcement.showUntil,
  audience: {
    roles: [...announcement.audience.roles],
    specialties: [...announcement.audience.specialties],
    provinces: [...announcement.audience.provinces],
    cities: [...announcement.audience.cities],
    organisationIds: announcement.audience.organisationIds.map(String),
    userIds: announcement.audience.userIds.map(String),
  },
  placements: [...announcement.placements],
  priority: announcement.priority,
  maxShows: announcement.maxShows,
});

const step = (name: AnnouncementStep, by: Types.ObjectId, fields: string[] = []) => ({
  step: name,
  at: new Date(),
  by,
  fields,
});

/**
 * Tell open apps. Clinic apps hear a published one change; the sponsor's
 * own members hear any change to theirs, a draft included, so the company's
 * list follows it. Edited from one sponsor to another, both are told.
 */
const announceChange = (
  announcement: AnnouncementDoc,
  change: 'created' | 'published' | 'edited' | 'withdrawn',
  actorId: Types.ObjectId,
  formerSponsorId: Types.ObjectId | null = null,
): void => {
  const sponsorIds = [announcement.sponsorId, formerSponsorId].filter(
    (id, index, all): id is Types.ObjectId => id !== null && all.findIndex((other) => other?.equals(id)) === index,
  );
  emit('announcement.changed', {
    announcementId: announcement._id,
    change,
    toClinics: announcement.status !== 'draft',
    sponsorIds,
    actorId,
  });
};

/** The sponsor company, for its allowance. Null when there is none, or it has gone. */
const sponsorCompany = async (sponsorId: Types.ObjectId | string | null) =>
  sponsorId ? Practice.findOne({ _id: sponsorId, type: 'company' }).select('announcementAllowance') : null;

/** `POST /announcements`: a draft. Nobody outside the console sees it until it is published. */
export const createAnnouncement = async (scope: Audited, body: CreateAnnouncementBody): Promise<AnnouncementView> => {
  await checkReferences(scope, body);
  const announcement = await Announcement.create({
    ...body,
    status: 'draft',
    history: [step('created', scope.actorId)],
    createdBy: scope.actorId,
  });
  await writeAudit(scope, {
    action: 'announcement.create',
    entity: 'announcement',
    entityId: announcement._id,
    after: asBody(announcement),
    requestId: scope.requestId ?? null,
  });
  return viewOf(announcement);
};

/**
 * `PATCH /announcements/:id`. Checked as the whole announcement it would
 * leave. A published one may be edited: its open apps are told, and if the
 * event moved, the reminders move with it.
 */
export const updateAnnouncement = async (
  scope: Audited,
  id: string,
  body: UpdateAnnouncementBody,
): Promise<AnnouncementView> => {
  const announcement = await findAnnouncement(id);
  if (announcement.status === 'withdrawn') {
    throw wrongStatus(announcement, 'a withdrawn one cannot be edited');
  }
  const before = asBody(announcement);
  const parsed = announcementSchema.safeParse({ ...before, ...body });
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => ({
      field: ['body', ...issue.path.map(String)].join('.'),
      message: issue.message,
    }));
    throw new AppError(
      'VALIDATION_ERROR',
      details.map((detail) => `${detail.field}: ${detail.message}`).join(', '),
      details,
    );
  }
  const next = parsed.data;
  await checkReferences(scope, next);

  const changed = (Object.keys(body) as (keyof CreateAnnouncementBody)[]).filter(
    (field) => JSON.stringify(before[field]) !== JSON.stringify(next[field]),
  );
  if (changed.length === 0) {
    return viewOf(announcement);
  }

  // A published one's sponsor must still be within its allowance: its reach
  // when the audience or the sponsor changes, and its posts when the sponsor
  // does. The post counts in the month it was first published, for whichever
  // company sponsors it now.
  const formerSponsorId = announcement.sponsorId;
  const sponsorMoved = changed.includes('sponsorId');
  const month = announcement.publishedAt ? karachiMonth(announcement.publishedAt) : null;
  let claimed: Types.ObjectId | null = null;
  if (announcement.status === 'published' && month) {
    const sponsor = await sponsorCompany(next.sponsorId);
    if (sponsor && (sponsorMoved || changed.includes('audience'))) {
      await assertReach(allowanceOf(sponsor), next.audience);
    }
    if (sponsor && sponsorMoved) {
      await claimPost(sponsor._id, month, allowanceOf(sponsor).postsPerMonth);
      claimed = sponsor._id;
    }
  }

  const startsBefore = announcement.event?.startsAt?.getTime() ?? null;
  changed.forEach((field) => announcement.set(field, next[field]));
  announcement.history.push(step('edited', scope.actorId, changed));
  try {
    await announcement.save();
  } catch (error) {
    if (claimed && month) {
      await releasePost(claimed, month);
    }
    throw error;
  }
  if (announcement.status === 'published' && month && sponsorMoved && formerSponsorId) {
    await releasePost(formerSponsorId, month);
  }

  await writeAudit(scope, {
    action: 'announcement.update',
    entity: 'announcement',
    entityId: announcement._id,
    before: Object.fromEntries(changed.map((field) => [field, before[field]])),
    after: Object.fromEntries(changed.map((field) => [field, next[field]])),
    requestId: scope.requestId ?? null,
  });

  if (announcement.status === 'published' && (announcement.event?.startsAt?.getTime() ?? null) !== startsBefore) {
    await rescheduleReminders(announcement);
  }
  // A draft's edits are news only to its sponsor, whose list shows it.
  if (announcement.status === 'published' || announcement.sponsorId || formerSponsorId) {
    announceChange(announcement, 'edited', scope.actorId, formerSponsorId);
  }
  return viewOf(announcement);
};

/**
 * `POST /announcements/:id/publish`: a draft goes live inside its window. A
 * sponsored one must fit its sponsor's allowance: its audience within the
 * reach one post may have, and a post left this month, taken before it is
 * published so two publishes at once cannot both have the last one.
 */
export const publishAnnouncement = async (scope: Audited, id: string, now: Date = new Date()): Promise<AnnouncementView> => {
  const announcement = await findAnnouncement(id);
  if (announcement.status !== 'draft') {
    throw wrongStatus(announcement, 'only a draft can be published');
  }
  if (hasEnded(announcement, now)) {
    throw new AppError('ANNOUNCEMENT_ENDED', 'Its window has already passed. Move showUntil before publishing it.');
  }
  // The medicine or the sponsor may have changed since the draft was written.
  await checkReferences(scope, announcementSchema.parse(asBody(announcement)));

  const month = karachiMonth(now);
  const sponsor = await sponsorCompany(announcement.sponsorId);
  if (sponsor) {
    await assertReach(allowanceOf(sponsor), announcement.audience);
    await claimPost(sponsor._id, month, allowanceOf(sponsor).postsPerMonth);
  }

  let published: AnnouncementDoc | null;
  try {
    published = await Announcement.findOneAndUpdate(
      { _id: announcement._id, status: 'draft' },
      { $set: { status: 'published', publishedAt: now }, $push: { history: step('published', scope.actorId) } },
      { new: true },
    );
  } catch (error) {
    if (sponsor) {
      await releasePost(sponsor._id, month);
    }
    throw error;
  }
  if (!published) {
    if (sponsor) {
      await releasePost(sponsor._id, month);
    }
    throw wrongStatus(announcement, 'it changed while you were publishing it');
  }
  await writeAudit(scope, {
    action: 'announcement.publish',
    entity: 'announcement',
    entityId: published._id,
    before: { status: announcement.status },
    after: { status: published.status },
    requestId: scope.requestId ?? null,
  });
  announceChange(published, 'published', scope.actorId);
  return viewOf(published);
};

/** `POST /announcements/:id/withdraw`: taken down for good, and every reminder not yet sent is cancelled. */
export const withdrawAnnouncement = async (scope: Audited, id: string): Promise<AnnouncementView> => {
  const announcement = await findAnnouncement(id);
  if (announcement.status !== 'published') {
    throw wrongStatus(announcement, 'only a published one can be withdrawn');
  }
  const withdrawn = await Announcement.findOneAndUpdate(
    { _id: announcement._id, status: 'published' },
    { $set: { status: 'withdrawn', withdrawnAt: new Date() }, $push: { history: step('withdrawn', scope.actorId) } },
    { new: true },
  );
  if (!withdrawn) {
    throw wrongStatus(announcement, 'it changed while you were withdrawing it');
  }
  const cancelled = await cancelReminders(withdrawn._id);
  await writeAudit(scope, {
    action: 'announcement.withdraw',
    entity: 'announcement',
    entityId: withdrawn._id,
    before: { status: announcement.status },
    after: { status: withdrawn.status, remindersCancelled: cancelled },
    requestId: scope.requestId ?? null,
  });
  announceChange(withdrawn, 'withdrawn', scope.actorId);
  return viewOf(withdrawn);
};

/**
 * A company's approved submission, as a draft in the console: the company as
 * sponsor, the audience it asked for (by rule only), shown in the updates
 * list at priority 0 with no cap. RxDictate adjusts it and publishes it here,
 * where the allowance is checked; approving publishes nothing.
 *
 * The product is checked again first, since it may have been discontinued
 * or changed hands while the submission waited.
 */
export const createFromSubmission = async (
  scope: Audited,
  submission: { _id: Types.ObjectId; practiceId: Types.ObjectId },
  payload: CompanyAnnouncementPayload,
): Promise<AnnouncementDoc> => {
  if (payload.drugId) {
    await checkSponsorProduct(payload.drugId, String(submission.practiceId), 'payload.drugId');
  }
  const announcement = await Announcement.create({
    ...payload,
    sponsorId: submission.practiceId,
    audience: { ...payload.audience, organisationIds: [], userIds: [] },
    placements: ['inbox.updates'],
    priority: 0,
    maxShows: null,
    status: 'draft',
    history: [step('created', scope.actorId)],
    submissionId: submission._id,
    createdBy: scope.actorId,
  });
  await writeAudit(scope, {
    action: 'announcement.create',
    entity: 'announcement',
    entityId: announcement._id,
    after: { ...asBody(announcement), submissionId: String(submission._id) },
    requestId: scope.requestId ?? null,
  });
  announceChange(announcement, 'created', scope.actorId);
  return announcement;
};

/**
 * `POST /announcements/images`: somewhere to PUT one image, as a report page
 * is uploaded. Hand the key back as `imageKey`. The key is filed under the
 * organisation that asked, the console's or a company's, and that is how
 * each is later told whether the image is theirs to use.
 */
export const createImageUpload = async (scope: Scope, body: CreateAnnouncementImageBody): Promise<UploadTicket> => {
  const key = announcementImageKey(scope.practiceId, randomBytes(12).toString('hex'), reportExtensionFor(body.contentType));
  const signed = await signedPutUrl(key, body.contentType, { size: body.size });
  return { uploadUrl: signed.url, fileKey: key, expiresAt: signed.expiresAt };
};

/**
 * `POST /announcements/audience-count`: how many people this audience reaches
 * now. A company asks by rule only, as its submission does: naming clinics or
 * people would let it learn who works where.
 */
export const audienceCount = async (audience: AnnouncementAudience, byRuleOnly = false): Promise<{ users: number }> => {
  if (byRuleOnly) {
    if (audience.organisationIds.length > 0) {
      throw invalid('audience.organisationIds', 'a company asks by rule only, never by clinic');
    }
    if (audience.userIds.length > 0) {
      throw invalid('audience.userIds', 'a company asks by rule only, never by person');
    }
  }
  return { users: await countAudience(audience) };
};

/* ------------------------------------------------------------------ *
 * Measurement and registrations
 * ------------------------------------------------------------------ */

/** Totals for a page of announcements, in two queries. Never who. */
export const statsFor = async (announcements: AnnouncementDoc[]): Promise<Map<string, AnnouncementStatsView>> => {
  const ids = announcements.map((announcement) => announcement._id);
  const [states, registrations] = await Promise.all([
    AnnouncementState.aggregate<{ _id: Types.ObjectId; dismissals: number; reminders: number }>([
      { $match: { announcementId: { $in: ids } } },
      {
        $group: {
          _id: '$announcementId',
          dismissals: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$dismissedAt', null] }, null] }, 1, 0] } },
          reminders: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$remindedAt', null] }, null] }, 1, 0] } },
        },
      },
    ]),
    AnnouncementRegistration.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { announcementId: { $in: ids } } },
      { $group: { _id: '$announcementId', count: { $sum: 1 } } },
    ]),
  ]);
  const stateOf = new Map(states.map((row) => [String(row._id), row]));
  const registeredOf = new Map(registrations.map((row) => [String(row._id), row.count]));
  return new Map(
    announcements.map((announcement) => {
      const id = String(announcement._id);
      return [
        id,
        {
          shows: announcement.stats?.shows ?? 0,
          clicks: announcement.stats?.clicks ?? 0,
          dismissals: stateOf.get(id)?.dismissals ?? 0,
          reminders: stateOf.get(id)?.reminders ?? 0,
          registrations: registeredOf.get(id) ?? 0,
        },
      ];
    }),
  );
};

/** `GET /announcements/:id/stats`: totals only. Never who. */
export const getStats = async (id: string): Promise<AnnouncementStatsView> => {
  const announcement = await findAnnouncement(id);
  return (await statsFor([announcement])).get(String(announcement._id))!;
};

const toRegistrationView = (registration: AnnouncementRegistrationDoc): AnnouncementRegistrationView => ({
  id: String(registration._id),
  userId: String(registration.userId),
  name: registration.name,
  phone: registration.phone,
  clinic: { id: String(registration.practiceId), name: registration.clinicName },
  registeredAt: registration.createdAt,
});

/** `GET /announcements/:id/registrations`: who registered, in the order they came. */
export const listRegistrations = async (
  id: string,
  query: ListAnnouncementRegistrationsQuery,
): Promise<{ registrations: AnnouncementRegistrationView[]; meta: PageMeta }> => {
  const announcement = await findAnnouncement(id);
  const result = await AnnouncementRegistration.paginate(
    { announcementId: announcement._id },
    { page: query.page, limit: query.limit, sortBy: 'createdAt:asc,_id:asc' },
  );
  return {
    registrations: result.results.map(toRegistrationView),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

/** `GET /announcements/:id/registrations.csv`: the same list, as a file for the organiser. */
export const registrationsCsv = async (id: string): Promise<{ filename: string; csv: string }> => {
  const announcement = await findAnnouncement(id);
  const registrations = await AnnouncementRegistration.find({ announcementId: announcement._id }).sort({
    createdAt: 1,
    _id: 1,
  });
  const csv = toCsv([
    ['Name', 'Phone', 'Clinic', 'Registered (Pakistan time)'],
    ...registrations.map((registration) => [
      registration.name,
      registration.phone,
      registration.clinicName,
      `${karachiDay(registration.createdAt)} ${karachiClock(registration.createdAt)}`,
    ]),
  ]);
  return { filename: `registrations-${String(announcement._id)}.csv`, csv };
};

export default {
  listAnnouncements,
  searchPeople,
  reach,
  createFromSubmission,
  statsFor,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  publishAnnouncement,
  withdrawAnnouncement,
  createImageUpload,
  audienceCount,
  getStats,
  listRegistrations,
  registrationsCsv,
};
