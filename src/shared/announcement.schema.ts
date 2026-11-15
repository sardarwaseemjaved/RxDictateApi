import { z } from 'zod';
import { objectIdSchema, paginationQuerySchema } from './common';
import { citySchema, provinceSchema } from './location.schema';
import { specialtySchema } from './specialties';
import { medicineFormSchema } from './prescription.schema';

/**
 * Announcements: seminars, events, updates and sponsored products, written and
 * published by RxDictate's own team and shown to clinic members in named
 * slots. Separate from a clinic's own notifications ("patient added"), which
 * stay as they are.
 *
 * Never in the consult, on the printout or PDF, on anything a patient sees, on
 * the verification page, or in medicine search and suggestions. Nothing paid
 * ever touches what a doctor is suggested.
 */

/* ------------------------------------------------------------------ *
 * Enums
 * ------------------------------------------------------------------ */

/**
 * - `seminar`, `event`: something on a date, which a doctor may be reminded of
 *   and register for.
 * - `update`: news from RxDictate or a company.
 * - `product`: one active national medicine, always sponsored by a company and
 *   always labelled "Sponsored".
 */
export const announcementKindSchema = z.enum(['seminar', 'event', 'update', 'product']);
export type AnnouncementKind = z.infer<typeof announcementKindSchema>;

/** The kinds that happen on a date, and so take a reminder and a registration. */
export const DATED_KINDS: readonly AnnouncementKind[] = ['seminar', 'event'];

/** The button it shows. `register` and `addToCalendar` only for a seminar or an event. */
export const announcementCtaSchema = z.enum(['register', 'learnMore', 'addToCalendar', 'none']);
export type AnnouncementCta = z.infer<typeof announcementCtaSchema>;

/**
 * - `draft`: being written; nobody outside the console sees it.
 * - `published`: shown inside its window. It may still be edited.
 * - `withdrawn`: taken down for good, its reminders cancelled.
 *
 * "Ended" is not a status: it is a published one whose `showUntil` has passed,
 * and the views say so in `ended`.
 */
export const announcementStatusSchema = z.enum(['draft', 'published', 'withdrawn']);
export type AnnouncementStatus = z.infer<typeof announcementStatusSchema>;

/**
 * Where an app shows one. A screen that offers a slot draws one component for
 * it, and the server picks what goes there. A new slot is one entry here and
 * one in ANNOUNCEMENT_PLACEMENT_LIMITS.
 */
export const announcementPlacementSchema = z.enum(['today.banner', 'sidebar.card', 'inbox.updates']);
export type AnnouncementPlacement = z.infer<typeof announcementPlacementSchema>;

/** How many a slot shows at once. Null is a list. */
export const ANNOUNCEMENT_PLACEMENT_LIMITS: Record<AnnouncementPlacement, number | null> = {
  'today.banner': 1,
  'sidebar.card': 1,
  'inbox.updates': null,
};

/** The clinic roles an audience may name. Never a patient, a company or the platform. */
export const audienceRoleSchema = z.enum(['doctor', 'pa', 'medicineManager']);
export type AudienceRole = z.infer<typeof audienceRoleSchema>;

/** What a clinic member's app reports back about one it drew. */
export const announcementEventTypeSchema = z.enum(['shown', 'clicked', 'dismissed']);
export type AnnouncementEventType = z.infer<typeof announcementEventTypeSchema>;

/** An image, uploaded the way a report page is: a signed upload URL first, then the key. */
export const ANNOUNCEMENT_IMAGE = {
  contentTypes: ['image/jpeg', 'image/png'] as const,
  /** 2 MB: a banner, not a brochure. */
  maxBytes: 2 * 1024 * 1024,
};

/* ------------------------------------------------------------------ *
 * Parts
 * ------------------------------------------------------------------ */

const httpsUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'must be an https link');

/**
 * Who it is for (section 6 of the design). Each list left empty matches
 * everyone; each one filled must match, so `{ roles: ['doctor'], cities:
 * ['Lahore'] }` is the doctors in Lahore. Empty everywhere is every clinic
 * member.
 *
 * - `specialties`: the person has at least one of them.
 * - `provinces`, `cities`: the location the app is open at, or with none, any
 *   location the member works at.
 * - `organisationIds`: clinics. `userIds`: people.
 */
export const announcementAudienceSchema = z.object({
  roles: z.array(audienceRoleSchema).max(3).default([]),
  specialties: z.array(specialtySchema).max(50).default([]),
  provinces: z.array(provinceSchema).max(20).default([]),
  cities: z
    .array(citySchema)
    .max(100)
    .default([])
    .transform((cities) => cities.filter((city): city is string => city !== null)),
  organisationIds: z.array(objectIdSchema).max(500).default([]),
  userIds: z.array(objectIdSchema).max(500).default([]),
});
export type AnnouncementAudience = z.infer<typeof announcementAudienceSchema>;

/** When and where a seminar or an event happens. A place, an online link, or both. */
export const announcementEventDetailsSchema = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().default(null),
  place: z.string().trim().max(300).nullable().default(null),
  onlineUrl: httpsUrlSchema.nullable().default(null),
});
export type AnnouncementEventDetails = z.infer<typeof announcementEventDetailsSchema>;

/* ------------------------------------------------------------------ *
 * Writing one (the console)
 * ------------------------------------------------------------------ */

const announcementFields = {
  kind: announcementKindSchema,
  title: z.string().trim().min(1).max(120),
  /** Plain text. */
  body: z.string().trim().min(1).max(1000),
  /** A key from POST /announcements/images, or null for none. */
  imageKey: z.string().min(1).max(200).nullable().default(null),
  link: httpsUrlSchema.nullable().default(null),
  cta: announcementCtaSchema.default('none'),
  /** Required for a seminar or an event; null for anything else. */
  event: announcementEventDetailsSchema.nullable().default(null),
  /** Required for a product: an active national medicine owned by sponsorId. Null for anything else. */
  drugId: objectIdSchema.nullable().default(null),
  /** A company, or null for RxDictate's own. A product needs one. */
  sponsorId: objectIdSchema.nullable().default(null),
  showFrom: z.coerce.date(),
  showUntil: z.coerce.date(),
  audience: announcementAudienceSchema.default({
    roles: [],
    specialties: [],
    provinces: [],
    cities: [],
    organisationIds: [],
    userIds: [],
  }),
  placements: z
    .array(announcementPlacementSchema)
    .min(1)
    .refine((placements) => new Set(placements).size === placements.length, 'names a placement twice'),
  /** Higher shows first. */
  priority: z.number().int().min(-1000).max(1000).default(0),
  /** How many times one person is shown it. Null: until they dismiss it. */
  maxShows: z.number().int().min(1).max(1000).nullable().default(null),
};

/**
 * The rules between fields, checked on create and again on every edit against
 * the announcement as it would then stand.
 */
const announcementRules = (
  value: {
    kind: AnnouncementKind;
    cta: AnnouncementCta;
    event: AnnouncementEventDetails | null;
    drugId: string | null;
    sponsorId: string | null;
    showFrom: Date;
    showUntil: Date;
  },
  ctx: z.RefinementCtx,
): void => {
  const dated = DATED_KINDS.includes(value.kind);
  if (dated && !value.event) {
    ctx.addIssue({ code: 'custom', path: ['event'], message: 'is needed for a seminar or an event' });
  }
  if (!dated && value.event) {
    ctx.addIssue({ code: 'custom', path: ['event'], message: 'is only for a seminar or an event' });
  }
  if (value.event) {
    if (!value.event.place && !value.event.onlineUrl) {
      ctx.addIssue({ code: 'custom', path: ['event', 'place'], message: 'needs a place or an online link' });
    }
    if (value.event.endsAt && value.event.endsAt <= value.event.startsAt) {
      ctx.addIssue({ code: 'custom', path: ['event', 'endsAt'], message: 'must be after it starts' });
    }
  }
  if (!dated && (value.cta === 'register' || value.cta === 'addToCalendar')) {
    ctx.addIssue({ code: 'custom', path: ['cta'], message: 'is only for a seminar or an event' });
  }
  if (value.kind === 'product') {
    if (!value.drugId) {
      ctx.addIssue({ code: 'custom', path: ['drugId'], message: 'is needed for a product' });
    }
    if (!value.sponsorId) {
      ctx.addIssue({ code: 'custom', path: ['sponsorId'], message: 'is needed for a product' });
    }
  } else if (value.drugId) {
    ctx.addIssue({ code: 'custom', path: ['drugId'], message: 'is only for a product' });
  }
  if (value.showUntil <= value.showFrom) {
    ctx.addIssue({ code: 'custom', path: ['showUntil'], message: 'must be after showFrom' });
  }
};

/** `POST /announcements`: a new one, as a draft. */
export const createAnnouncementBodySchema = z.object(announcementFields).superRefine(announcementRules);
export type CreateAnnouncementBody = z.infer<typeof createAnnouncementBodySchema>;

/**
 * `PATCH /announcements/:id`: only what changes. `audience` and `event` are
 * replaced whole. The result is checked by the same rules as a new one. A
 * published one may be edited too; withdrawn ones may not.
 */
export const updateAnnouncementBodySchema = z
  .object({
    kind: announcementFields.kind,
    title: announcementFields.title,
    body: announcementFields.body,
    imageKey: z.string().min(1).max(200).nullable(),
    link: httpsUrlSchema.nullable(),
    cta: announcementCtaSchema,
    event: announcementEventDetailsSchema.nullable(),
    drugId: objectIdSchema.nullable(),
    sponsorId: objectIdSchema.nullable(),
    showFrom: announcementFields.showFrom,
    showUntil: announcementFields.showUntil,
    audience: announcementAudienceSchema,
    placements: announcementFields.placements,
    priority: z.number().int().min(-1000).max(1000),
    maxShows: z.number().int().min(1).max(1000).nullable(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
export type UpdateAnnouncementBody = z.infer<typeof updateAnnouncementBodySchema>;

/** The whole announcement as an edit would leave it, checked before it is saved. */
export const announcementSchema = createAnnouncementBodySchema;

/** `GET /announcements`: newest first. */
export const listAnnouncementsQuerySchema = paginationQuerySchema.extend({
  status: announcementStatusSchema.optional(),
  kind: announcementKindSchema.optional(),
  /** A company's id, or `none` for RxDictate's own. */
  sponsorId: z.union([objectIdSchema, z.literal('none')]).optional(),
});
export type ListAnnouncementsQuery = z.infer<typeof listAnnouncementsQuerySchema>;

/** The console's national catalog, independent of clinic lists and medicines.source. */
export const searchAnnouncementProductsQuerySchema = z.object({
  q: z.string().trim().max(120).default(''),
  /** Only products owned by this company. A blank q lists them by name. */
  sponsorId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchAnnouncementProductsQuery = z.infer<typeof searchAnnouncementProductsQuerySchema>;

/** One result of GET /announcements/products. An unclaimed DRAP row has no company. */
export const announcementProductViewSchema = z.object({
  id: objectIdSchema,
  brand: z.string(),
  strength: z.string(),
  form: medicineFormSchema,
  composition: z.string(),
  registrationNo: z.string().nullable(),
  company: z.object({ id: objectIdSchema, name: z.string() }).nullable(),
});
export type AnnouncementProductView = z.infer<typeof announcementProductViewSchema>;

/** `POST /announcements/images`: somewhere to PUT one image. Answers an upload ticket, as reports do. */
export const createAnnouncementImageBodySchema = z.object({
  contentType: z.enum(ANNOUNCEMENT_IMAGE.contentTypes),
  size: z.number().int().min(1).max(ANNOUNCEMENT_IMAGE.maxBytes),
});
export type CreateAnnouncementImageBody = z.infer<typeof createAnnouncementImageBodySchema>;

/** `POST /announcements/audience-count`: an audience, typically the one being edited. */
export const audienceCountBodySchema = z.object({ audience: announcementAudienceSchema });
export type AudienceCountBody = z.infer<typeof audienceCountBodySchema>;

export const audienceCountViewSchema = z.object({
  /** People, not memberships: someone in two clinics counts once. */
  users: z.number().int(),
});
export type AudienceCountView = z.infer<typeof audienceCountViewSchema>;

/* ------------------------------------------------------------------ *
 * Console views
 * ------------------------------------------------------------------ */

const signedImageSchema = z.object({ url: z.string(), expiresAt: z.coerce.date() });

const sponsorViewSchema = z.object({ id: objectIdSchema, name: z.string() });

/** The product a `product` announcement is about, as doctors see it named. */
const productViewSchema = z.object({ id: objectIdSchema, brand: z.string(), strength: z.string() });

export const announcementStepSchema = z.enum(['created', 'edited', 'published', 'withdrawn']);
export type AnnouncementStep = z.infer<typeof announcementStepSchema>;

export const announcementHistoryEntrySchema = z.object({
  step: announcementStepSchema,
  at: z.coerce.date(),
  by: objectIdSchema,
  /** For an edit, the fields it changed. */
  fields: z.array(z.string()),
});
export type AnnouncementHistoryEntry = z.infer<typeof announcementHistoryEntrySchema>;

export const announcementViewSchema = z.object({
  id: objectIdSchema,
  kind: announcementKindSchema,
  title: z.string(),
  body: z.string(),
  imageKey: z.string().nullable(),
  image: signedImageSchema.nullable(),
  link: z.string().nullable(),
  cta: announcementCtaSchema,
  event: z
    .object({
      startsAt: z.coerce.date(),
      endsAt: z.coerce.date().nullable(),
      place: z.string().nullable(),
      onlineUrl: z.string().nullable(),
    })
    .nullable(),
  drugId: objectIdSchema.nullable(),
  product: productViewSchema.nullable(),
  sponsor: sponsorViewSchema.nullable(),
  /** A sponsor is set, or it is a product. Always labelled "Sponsored". */
  isSponsored: z.boolean(),
  showFrom: z.coerce.date(),
  showUntil: z.coerce.date(),
  audience: z.object({
    roles: z.array(audienceRoleSchema),
    specialties: z.array(specialtySchema),
    provinces: z.array(provinceSchema),
    cities: z.array(z.string()),
    organisationIds: z.array(objectIdSchema),
    userIds: z.array(objectIdSchema),
  }),
  placements: z.array(announcementPlacementSchema),
  priority: z.number().int(),
  maxShows: z.number().int().nullable(),
  status: announcementStatusSchema,
  /** Published, and its window has passed. */
  ended: z.boolean(),
  publishedAt: z.coerce.date().nullable(),
  withdrawnAt: z.coerce.date().nullable(),
  history: z.array(announcementHistoryEntrySchema),
  createdBy: objectIdSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AnnouncementView = z.infer<typeof announcementViewSchema>;

/** `GET /announcements/:id/stats`: totals only, never who. */
export const announcementStatsViewSchema = z.object({
  /** Every time an app drew it. */
  shows: z.number().int(),
  clicks: z.number().int(),
  /** People who dismissed it. */
  dismissals: z.number().int(),
  /** People with a reminder set now. */
  reminders: z.number().int(),
  /** People registered now. */
  registrations: z.number().int(),
});
export type AnnouncementStatsView = z.infer<typeof announcementStatsViewSchema>;

/** One person who registered, for the organiser. Only with their consent. */
export const announcementRegistrationViewSchema = z.object({
  id: objectIdSchema,
  userId: objectIdSchema,
  name: z.string(),
  phone: z.string(),
  clinic: z.object({ id: objectIdSchema, name: z.string() }),
  registeredAt: z.coerce.date(),
});
export type AnnouncementRegistrationView = z.infer<typeof announcementRegistrationViewSchema>;

export const listAnnouncementRegistrationsQuerySchema = paginationQuerySchema;
export type ListAnnouncementRegistrationsQuery = z.infer<typeof listAnnouncementRegistrationsQuerySchema>;

/* ------------------------------------------------------------------ *
 * What a clinic member sees
 * ------------------------------------------------------------------ */

/** `GET /announcements/slots?placement=…`. */
export const announcementSlotsQuerySchema = z.object({ placement: announcementPlacementSchema });
export type AnnouncementSlotsQuery = z.infer<typeof announcementSlotsQuerySchema>;

/**
 * One announcement, as a clinic member's slot shows it. The list a slot gets
 * is in order (priority, then newest) and holds at most
 * ANNOUNCEMENT_PLACEMENT_LIMITS for that placement.
 */
export const announcementSlotViewSchema = z.object({
  id: objectIdSchema,
  kind: announcementKindSchema,
  title: z.string(),
  body: z.string(),
  image: signedImageSchema.nullable(),
  link: z.string().nullable(),
  cta: announcementCtaSchema,
  event: announcementViewSchema.shape.event,
  sponsor: sponsorViewSchema.nullable(),
  isSponsored: z.boolean(),
  product: productViewSchema.nullable(),
  showUntil: z.coerce.date(),
  /** This person's own state. */
  reminded: z.boolean(),
  registered: z.boolean(),
});
export type AnnouncementSlotView = z.infer<typeof announcementSlotViewSchema>;

/**
 * `POST /announcements/:id/events`. Send `shown` when the app actually draws
 * it: that is what the cap counts. `dismissed` hides it from this person for good.
 */
export const announcementEventBodySchema = z.object({ type: announcementEventTypeSchema });
export type AnnouncementEventBody = z.infer<typeof announcementEventBodySchema>;

/** This person's state on one, after an event, a reminder or a registration. */
export const announcementStateViewSchema = z.object({
  shows: z.number().int(),
  dismissed: z.boolean(),
  reminded: z.boolean(),
  registered: z.boolean(),
});
export type AnnouncementStateView = z.infer<typeof announcementStateViewSchema>;

/**
 * `POST /announcements/:id/register`. Their name, phone and clinic go to the
 * organiser, so `consent` must be `true`, and nothing else will do.
 */
export const registerAnnouncementBodySchema = z.object({ consent: z.literal(true) });
export type RegisterAnnouncementBody = z.infer<typeof registerAnnouncementBodySchema>;
