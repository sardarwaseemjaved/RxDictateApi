import { Types } from 'mongoose';
import { Announcement, type AnnouncementDoc } from '../models';
import { AppError } from '../core/errors';
import type { Scope } from '../core/db';
import type { PageMeta } from '../shared/response';
import type {
  AnnouncementRegistrationView,
  CompanyAnnouncementPayload,
  CompanyAnnouncementView,
  ListAnnouncementRegistrationsQuery,
  ListCompanyAnnouncementsQuery,
} from '../shared/announcement.schema';
import {
  checkSponsorProduct,
  hasEnded,
  invalidAt,
  isImageOf,
  listRegistrations,
  productOf,
  referencesFor,
  registrationsCsv,
  statsFor,
} from './announcement.service';

/**
 * A company's own announcements: what it sends for review, and what it sees
 * afterwards of every announcement it sponsors, whoever wrote it.
 *
 * A company sees totals only, never who was shown one or who it reached, and
 * never the audience RxDictate chose: it must not learn which clinics or
 * doctors exist. The one exception is who registered for its own seminars
 * and events, which those people agreed to give the organiser.
 */

/**
 * What a company sends, checked beyond its schema: a product is one of its
 * own active medicines, and a picture is one it uploaded itself. `at` is
 * where the payload sits in the request: `body` when it is sent, and
 * `body.payload` when it is sent again.
 */
export const preparePayload = async (
  companyId: Types.ObjectId,
  payload: CompanyAnnouncementPayload,
  at: 'body' | 'body.payload',
): Promise<{ payload: Record<string, unknown>; drugId: null }> => {
  if (payload.drugId) {
    await checkSponsorProduct(payload.drugId, String(companyId), `${at}.drugId`);
  }
  if (payload.imageKey && !isImageOf(companyId, payload.imageKey)) {
    throw invalidAt(`${at}.imageKey`, 'was not uploaded by this company through POST /announcements/images');
  }
  // The submission's own drugId stays null: it is about an announcement, and a
  // product's submissions beside it in the company's list are about the product.
  return { payload: { ...payload }, drugId: null };
};

/** One the company sponsors, or NOT_FOUND: anything else is not theirs to know about. */
const sponsoredBy = async (scope: Scope, id: string): Promise<AnnouncementDoc> => {
  const announcement = Types.ObjectId.isValid(id)
    ? await Announcement.findOne({ _id: id, sponsorId: scope.practiceId })
    : null;
  if (!announcement) {
    throw AppError.notFound('Announcement');
  }
  return announcement;
};

/** `GET /company/announcements`: every one with this company as sponsor, newest first, with totals. */
export const listOwn = async (
  scope: Scope,
  query: ListCompanyAnnouncementsQuery,
): Promise<{ announcements: CompanyAnnouncementView[]; meta: PageMeta }> => {
  const result = await Announcement.paginate(
    { sponsorId: scope.practiceId },
    { page: query.page, limit: query.limit, sortBy: 'createdAt:desc,_id:desc' },
  );
  const [references, stats] = await Promise.all([referencesFor(result.results), statsFor(result.results)]);
  return {
    announcements: result.results.map((announcement) => ({
      id: String(announcement._id),
      kind: announcement.kind,
      title: announcement.title,
      status: announcement.status,
      ended: announcement.status === 'published' && hasEnded(announcement),
      showFrom: announcement.showFrom,
      showUntil: announcement.showUntil,
      publishedAt: announcement.publishedAt,
      submissionId: announcement.submissionId ? String(announcement.submissionId) : null,
      product: productOf(announcement, references),
      stats: stats.get(String(announcement._id))!,
    })),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

/** `GET /company/announcements/:id/registrations`: the console's list, for its own seminars and events only. */
export const listOwnRegistrations = async (
  scope: Scope,
  id: string,
  query: ListAnnouncementRegistrationsQuery,
): Promise<{ registrations: AnnouncementRegistrationView[]; meta: PageMeta }> =>
  listRegistrations(String((await sponsoredBy(scope, id))._id), query);

/** `GET /company/announcements/:id/registrations.csv`. */
export const ownRegistrationsCsv = async (scope: Scope, id: string): Promise<{ filename: string; csv: string }> =>
  registrationsCsv(String((await sponsoredBy(scope, id))._id));

export default { preparePayload, listOwn, listOwnRegistrations, ownRegistrationsCsv };
