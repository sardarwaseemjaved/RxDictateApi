import type { Request } from 'express';
import type { Types } from 'mongoose';
import { AuditLog } from '../../models/auditLog.model';
import type { Scope } from '../db';

export interface AuditEntry {
  /** `entity.verb`, the same name as the permission. */
  action: string;
  entity: string;
  entityId?: Types.ObjectId | null;
  before?: unknown;
  after?: unknown;
  locationId?: Types.ObjectId | null;
  requestId?: string | null;
  ip?: string | null;
}

/**
 * Append-only: this is the only function that writes to auditLogs, and nothing
 * anywhere updates or deletes a row.
 *
 * Awaited rather than fired and forgotten. An audit write that fails takes the
 * request down with it, which is the right trade for a clinical record: a loud
 * failure beats a silent gap in the history. In practice the only thing that
 * makes this fail is the database being unreachable, in which case the write it
 * is recording failed too.
 */
export const writeAudit = async (scope: Scope, entry: AuditEntry): Promise<void> => {
  await AuditLog.create({
    practiceId: scope.practiceId,
    locationId: entry.locationId ?? scope.locationId ?? null,
    actorId: scope.actorId,
    role: scope.role,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    at: new Date(),
    requestId: entry.requestId ?? null,
    ip: entry.ip ?? null,
  });
};

/**
 * The scope a service audits with, taken from the request so the entry carries
 * the request id that produced it.
 */
export const auditScope = (req: Request): Scope & { requestId: string | null } => {
  const ctx = req.ctx!;
  return {
    practiceId: ctx.practiceId,
    actorId: ctx.actorId,
    role: ctx.role,
    allowedLocationIds: ctx.allowedLocationIds,
    locationId: ctx.locationId,
    requestId: req.id ?? null,
  };
};

export default { writeAudit, auditScope };
