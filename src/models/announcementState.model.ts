import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

/**
 * One person's state on one announcement: how often their apps drew it and
 * when, how often they clicked it, and whether they dismissed it or asked to
 * be reminded. The frequency cap and dismissal read this. RxDictate's admin
 * may read it person by person (`announcement.people.read`, audited); a
 * sponsor sees totals only.
 *
 * `clicks`, `firstShownAt` and `lastShownAt` were added in phase 6. A row
 * from before keeps their defaults: clicks were only counted on the
 * announcement then, so whose they were cannot be recovered, and an older
 * show has no time.
 */
export interface IAnnouncementState {
  announcementId: Types.ObjectId;
  userId: Types.ObjectId;
  shows: number;
  clicks: number;
  firstShownAt: Date | null;
  lastShownAt: Date | null;
  dismissedAt: Date | null;
  /** When they asked to be reminded, or null. The reminders themselves are jobs. */
  remindedAt: Date | null;
  /** The clinic they asked from, whose bell the reminders go to. */
  remindedPracticeId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AnnouncementStateDoc = HydratedDocument<IAnnouncementState>;

const announcementStateSchema = new Schema<IAnnouncementState>(
  {
    announcementId: { type: Schema.Types.ObjectId, ref: 'Announcement', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    shows: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    firstShownAt: { type: Date, default: null },
    lastShownAt: { type: Date, default: null },
    dismissedAt: { type: Date, default: null },
    remindedAt: { type: Date, default: null },
    remindedPracticeId: { type: Schema.Types.ObjectId, ref: 'Practice', default: null },
  },
  { timestamps: true },
);

announcementStateSchema.index({ announcementId: 1, userId: 1 }, { unique: true });
// A slot reads one person's state on every live announcement at once.
announcementStateSchema.index({ userId: 1 });

export const AnnouncementState = mongoose.model<IAnnouncementState>(
  'AnnouncementState',
  announcementStateSchema,
  'announcementStates',
);
export default AnnouncementState;
