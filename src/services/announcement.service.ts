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
  type AnnouncementProductView,
  type AnnouncementRegistrationView,
  type AnnouncementStatsView,
  type AnnouncementStep,
  type AnnouncementView,
  type CreateAnnouncementBody,
  type CreateAnnouncementImageBody,
  type ListAnnouncementRegistrationsQuery,
  type ListAnnouncementsQuery,
  type SearchAnnouncementProductsQuery,
  type UpdateAnnouncementBody,
} from '../shared/announcement.schema';
import { toCsv } from '../utils/csv';
import { karachiClock, karachiDay } from '../utils/time';
import { nationalRows, prefixOf } from './drugAccess.service';
import { countAudience } from './announcementAudience.service';
import { cancelReminders, rescheduleReminders } from './announcementReminder.service';

type Audited = Scope & { requestId?: string | null };

/**
 * Announcements, as RxDictate's console writes and publishes them.
 *
 * Only the platform's own team writes one in this phase, sponsored ones
 * included, so RxDictate is its own reviewer: a published one may be edited,
 * and every step is kept in its history and the audit log. What a clinic
 * member sees, and what they do with it, is announcementSlot.service.
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

const toView = async (announcement: AnnouncementDoc, references: References): Promise<AnnouncementView> => ({
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
  createdBy: String(announcement.createdBy),
  createdAt: announcement.createdAt,
  updatedAt: announcement.updatedAt,
});

const viewsOf = async (announcements: AnnouncementDoc[]): Promise<AnnouncementView[]> => {
  const references = await referencesFor(announcements);
  return Promise.all(announcements.map((announcement) => toView(announcement, references)));
};

const viewOf = async (announcement: AnnouncementDoc): Promise<AnnouncementView> => (await viewsOf([announcement]))[0];

export const findAnnouncement = async (id: string): Promise<AnnouncementDoc> => {
  const announcement = Types.ObjectId.isValid(id) ? await Announcement.findById(id) : null;
  if (!announcement) {
    throw AppError.notFound('Announcement');
  }
  return announcement;
};

/** `GET /announcements`: newest first. */
export const listAnnouncements = async (
  query: ListAnnouncementsQuery,
): Promise<{ announcements: AnnouncementView[]; meta: PageMeta }> => {
  const result = await Announcement.paginate(
    {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.sponsorId ? { sponsorId: query.sponsorId === 'none' ? null : new Types.ObjectId(query.sponsorId) } : {}),
    },
    { page: query.page, limit: query.limit, sortBy: 'createdAt:desc,_id:desc' },
  );
  return {
    announcements: await viewsOf(result.results),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
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

const invalid = (field: string, message: string): AppError =>
  new AppError('VALIDATION_ERROR', `body.${field}: ${message}`, [{ field: `body.${field}`, message }]);

const wrongStatus = (announcement: AnnouncementDoc, wanted: string): AppError =>
  new AppError('ANNOUNCEMENT_WRONG_STATUS', `This announcement is ${announcement.status}; ${wanted}.`, {
    status: announcement.status,
  });

/**
 * What an announcement names must exist and be the right kind of thing: an
 * image this console uploaded, a company as sponsor, an active national
 * medicine as the product, clinics as organisations.
 */
const checkReferences = async (scope: Scope, fields: CreateAnnouncementBody): Promise<void> => {
  if (fields.imageKey && !isIssuedAnnouncementImageKey(announcementImagePrefix(scope.practiceId), fields.imageKey)) {
    throw invalid('imageKey', 'was not issued by POST /announcements/images');
  }
  if (fields.sponsorId) {
    const sponsor = await Practice.exists({ _id: fields.sponsorId, type: 'company', deletedAt: null });
    if (!sponsor) {
      throw invalid('sponsorId', 'is not a company');
    }
  }
  if (fields.drugId) {
    const drug = await Drug.findOne({ ...nationalRows, _id: fields.drugId, status: 'active' }).select('companyId');
    if (!drug) {
      throw invalid('drugId', 'is not an active national medicine');
    }
    if (fields.kind === 'product' && (!drug.companyId || String(drug.companyId) !== fields.sponsorId)) {
      throw invalid('drugId', 'must be a product owned by the sponsor; unclaimed medicines must be claimed first');
    }
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

  const startsBefore = announcement.event?.startsAt?.getTime() ?? null;
  changed.forEach((field) => announcement.set(field, next[field]));
  announcement.history.push(step('edited', scope.actorId, changed));
  await announcement.save();

  await writeAudit(scope, {
    action: 'announcement.update',
    entity: 'announcement',
    entityId: announcement._id,
    before: Object.fromEntries(changed.map((field) => [field, before[field]])),
    after: Object.fromEntries(changed.map((field) => [field, next[field]])),
    requestId: scope.requestId ?? null,
  });

  if (announcement.status === 'published') {
    if ((announcement.event?.startsAt?.getTime() ?? null) !== startsBefore) {
      await rescheduleReminders(announcement);
    }
    emit('announcement.changed', { announcementId: announcement._id, change: 'edited', actorId: scope.actorId });
  }
  return viewOf(announcement);
};

/** `POST /announcements/:id/publish`: a draft goes live inside its window. */
export const publishAnnouncement = async (scope: Audited, id: string): Promise<AnnouncementView> => {
  const announcement = await findAnnouncement(id);
  if (announcement.status !== 'draft') {
    throw wrongStatus(announcement, 'only a draft can be published');
  }
  if (hasEnded(announcement)) {
    throw new AppError('ANNOUNCEMENT_ENDED', 'Its window has already passed. Move showUntil before publishing it.');
  }
  // The medicine or the sponsor may have changed since the draft was written.
  await checkReferences(scope, announcementSchema.parse(asBody(announcement)));

  const now = new Date();
  const published = await Announcement.findOneAndUpdate(
    { _id: announcement._id, status: 'draft' },
    { $set: { status: 'published', publishedAt: now }, $push: { history: step('published', scope.actorId) } },
    { new: true },
  );
  if (!published) {
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
  emit('announcement.changed', { announcementId: published._id, change: 'published', actorId: scope.actorId });
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
  emit('announcement.changed', { announcementId: withdrawn._id, change: 'withdrawn', actorId: scope.actorId });
  return viewOf(withdrawn);
};

/**
 * `POST /announcements/images`: somewhere to PUT one image, as a report page
 * is uploaded. Hand the key back as `imageKey`.
 */
export const createImageUpload = async (scope: Scope, body: CreateAnnouncementImageBody): Promise<UploadTicket> => {
  const key = announcementImageKey(scope.practiceId, randomBytes(12).toString('hex'), reportExtensionFor(body.contentType));
  const signed = await signedPutUrl(key, body.contentType, { size: body.size });
  return { uploadUrl: signed.url, fileKey: key, expiresAt: signed.expiresAt };
};

/** `POST /announcements/audience-count`: how many people this audience reaches now. */
export const audienceCount = async (audience: AnnouncementAudience): Promise<{ users: number }> => ({
  users: await countAudience(audience),
});

/* ------------------------------------------------------------------ *
 * Measurement and registrations
 * ------------------------------------------------------------------ */

/** `GET /announcements/:id/stats`: totals only. Never who. */
export const getStats = async (id: string): Promise<AnnouncementStatsView> => {
  const announcement = await findAnnouncement(id);
  const [dismissals, reminders, registrations] = await Promise.all([
    AnnouncementState.countDocuments({ announcementId: announcement._id, dismissedAt: { $ne: null } }),
    AnnouncementState.countDocuments({ announcementId: announcement._id, remindedAt: { $ne: null } }),
    AnnouncementRegistration.countDocuments({ announcementId: announcement._id }),
  ]);
  return {
    shows: announcement.stats?.shows ?? 0,
    clicks: announcement.stats?.clicks ?? 0,
    dismissals,
    reminders,
    registrations,
  };
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
