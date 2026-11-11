import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import {
  ANNOUNCEMENT_PLACEMENT_LIMITS,
  announcementCtaSchema,
  announcementKindSchema,
  announcementStatusSchema,
  announcementStepSchema,
  audienceRoleSchema,
  type AnnouncementCta,
  type AnnouncementKind,
  type AnnouncementPlacement,
  type AnnouncementStatus,
  type AnnouncementStep,
  type AudienceRole,
} from '../shared/announcement.schema';
import { PROVINCES, type Province } from '../shared/location.schema';
import { SPECIALTIES, type Specialty } from '../shared/specialties';

export interface IAnnouncementEvent {
  startsAt: Date;
  endsAt: Date | null;
  place: string | null;
  onlineUrl: string | null;
}

export interface IAnnouncementAudience {
  roles: AudienceRole[];
  specialties: Specialty[];
  provinces: Province[];
  cities: string[];
  organisationIds: Types.ObjectId[];
  userIds: Types.ObjectId[];
}

export interface IAnnouncementStep {
  step: AnnouncementStep;
  at: Date;
  by: Types.ObjectId;
  fields: string[];
}

/**
 * Something RxDictate shows clinic members in a named slot: a seminar, an
 * event, an update, or a sponsored product. Belongs to the platform, so it is
 * not a tenant's data and is never read through the scoped repository: the
 * console reads them all, and a clinic member only through the slot rules in
 * announcement.service.
 *
 * `stats` holds the totals of what apps reported - shows and clicks - and
 * nothing about who. Who has seen or dismissed one, which the
 * cap needs, is in announcementStates and never leaves the server.
 */
export interface IAnnouncement {
  kind: AnnouncementKind;
  title: string;
  body: string;
  imageKey: string | null;
  link: string | null;
  cta: AnnouncementCta;
  event: IAnnouncementEvent | null;
  drugId: Types.ObjectId | null;
  sponsorId: Types.ObjectId | null;
  showFrom: Date;
  showUntil: Date;
  audience: IAnnouncementAudience;
  placements: AnnouncementPlacement[];
  priority: number;
  maxShows: number | null;
  status: AnnouncementStatus;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
  stats: { shows: number; clicks: number };
  history: IAnnouncementStep[];
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export type AnnouncementDoc = HydratedDocument<IAnnouncement>;

const eventSchema = new Schema<IAnnouncementEvent>(
  {
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, default: null },
    place: { type: String, default: null },
    onlineUrl: { type: String, default: null },
  },
  { _id: false },
);

const audienceSchema = new Schema<IAnnouncementAudience>(
  {
    roles: { type: [{ type: String, enum: audienceRoleSchema.options }], default: [] },
    specialties: { type: [{ type: String, enum: SPECIALTIES }], default: [] },
    provinces: { type: [{ type: String, enum: PROVINCES }], default: [] },
    cities: { type: [String], default: [] },
    organisationIds: { type: [Schema.Types.ObjectId], default: [] },
    userIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
);

const stepSchema = new Schema<IAnnouncementStep>(
  {
    step: { type: String, enum: announcementStepSchema.options, required: true },
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fields: { type: [String], default: [] },
  },
  { _id: false },
);

const announcementSchema = new Schema<IAnnouncement>(
  {
    kind: { type: String, enum: announcementKindSchema.options, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    imageKey: { type: String, default: null },
    link: { type: String, default: null },
    cta: { type: String, enum: announcementCtaSchema.options, default: 'none' },
    event: { type: eventSchema, default: null },
    drugId: { type: Schema.Types.ObjectId, ref: 'Drug', default: null },
    sponsorId: { type: Schema.Types.ObjectId, ref: 'Practice', default: null },
    showFrom: { type: Date, required: true },
    showUntil: { type: Date, required: true },
    audience: { type: audienceSchema, default: () => ({}) },
    placements: {
      type: [{ type: String, enum: Object.keys(ANNOUNCEMENT_PLACEMENT_LIMITS) }],
      default: [],
    },
    priority: { type: Number, default: 0 },
    maxShows: { type: Number, default: null },
    status: { type: String, enum: announcementStatusSchema.options, default: 'draft' },
    publishedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    stats: {
      shows: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
    },
    history: { type: [stepSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

announcementSchema.plugin(toJSON);
announcementSchema.plugin(paginate);

// What a slot reads: live ones in one placement, inside their window.
announcementSchema.index({ status: 1, placements: 1, showFrom: 1, showUntil: 1 });
// The console's list, newest first, by status, kind or sponsor.
announcementSchema.index({ status: 1, createdAt: -1 });
announcementSchema.index({ sponsorId: 1, createdAt: -1 });

export const Announcement = mongoose.model<IAnnouncement, PaginateModel<IAnnouncement>>(
  'Announcement',
  announcementSchema,
  'announcements',
);
export default Announcement;
