import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';

/**
 * Append-only. Every write in the product lands here with its before and after,
 * and nothing in this codebase updates or deletes a row: when a PA is removed
 * her membership changes but what she did stays attributable.
 */
export interface IAuditLog {
  practiceId: Types.ObjectId;
  locationId: Types.ObjectId | null;
  actorId: Types.ObjectId;
  role: string;
  /** `entity.verb`, matching the permission names. */
  action: string;
  entity: string;
  entityId: Types.ObjectId | null;
  before: unknown;
  after: unknown;
  at: Date;
  requestId: string | null;
  /** Where the request came from. Worth having on a sign-in or a sign-out. */
  ip: string | null;
}

export type AuditLogDoc = HydratedDocument<IAuditLog>;

const auditLogSchema = new Schema<IAuditLog>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', default: null },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, required: true },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: Schema.Types.ObjectId, default: null },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    at: { type: Date, default: () => new Date() },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: false },
);

auditLogSchema.plugin(toJSON);
auditLogSchema.plugin(paginate);

auditLogSchema.index({ practiceId: 1, entity: 1, entityId: 1 });
auditLogSchema.index({ practiceId: 1, at: -1 });

export const AuditLog = mongoose.model<IAuditLog, PaginateModel<IAuditLog>>('AuditLog', auditLogSchema, 'auditLogs');
export default AuditLog;
