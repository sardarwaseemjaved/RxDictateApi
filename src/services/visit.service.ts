import { Patient, Visit, type IVisit, type PatientDoc, type VisitDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { CreateVisitBody, ListVisitsQuery, UpdateVisitBody, VisitStatus, VisitView } from '../shared/visit.schema';
import { todayInKarachi } from '../utils/time';
import { toPatientView } from './patient.service';
import { nextVisitToken } from './counter.service';

const visits = new BaseRepository<IVisit>(Visit, { locationScoped: true });

/**
 * The location this request is working in. resolveLocation has already proved
 * the caller may use it, so a missing one here is a routing mistake.
 */
const locationFrom = (scope: Scope) => {
  if (!scope.locationId) {
    throw new AppError('LOCATION_REQUIRED', 'X-Location-Id is required on this route');
  }
  return scope.locationId;
};

const toVisitView = (visit: VisitDoc, patient: PatientDoc | null): VisitView => ({
  id: String(visit._id),
  locationId: String(visit.locationId),
  patientId: String(visit.patientId),
  patient: patient ? toPatientView(patient) : null,
  date: visit.date,
  token: visit.token,
  reason: visit.reason,
  status: visit.status,
  statusChangedAt: visit.statusChangedAt,
  vitalsRecordedAt: visit.vitalsRecordedAt,
  createdAt: visit.createdAt,
});

/** The list is useless without names, and one query for the page beats one per row. */
const withPatients = async (found: VisitDoc[]): Promise<VisitView[]> => {
  const patients = await Patient.find({ _id: { $in: found.map((visit) => visit.patientId) } });
  const byId = new Map(patients.map((patient) => [String(patient._id), patient]));
  return found.map((visit) => toVisitView(visit, byId.get(String(visit.patientId)) ?? null));
};

export const listVisits = async (scope: Scope, query: ListVisitsQuery): Promise<VisitView[]> => {
  // 'today' is resolved against Asia/Karachi, not against the server's clock,
  // so a list does not roll over at five in the morning local time.
  const date = query.date === 'today' ? todayInKarachi() : query.date;

  const found = await visits.find(
    scope,
    { date, ...(query.status ? { status: query.status } : {}) },
    {
      sort: { createdAt: 1 },
    },
  );
  return withPatients(found);
};

/**
 * The visit this patient is on for a day at this location, creating it if they
 * are not on the list yet.
 *
 * Shared by POST /visits and by starting a prescription, so a doctor working
 * alone never has to think about the queue: writing a prescription puts the
 * patient on today's list by itself. Returns the document, because the
 * prescription needs its id.
 *
 * Adding the same patient to the same day twice is a double tap, not a second
 * visit, so the existing row comes back untouched - and no token is spent on
 * it.
 */
export const ensureVisit = async (
  scope: Scope,
  patient: PatientDoc,
  options: { date?: string; reason?: string } = {},
): Promise<{ visit: VisitDoc; created: boolean }> => {
  const date = options.date ?? todayInKarachi();

  const existing = await visits.findOne(scope, { patientId: patient._id, date });
  if (existing) {
    return { visit: existing, created: false };
  }

  const now = new Date();
  const visit = await visits.create(scope, {
    patientId: patient._id,
    date,
    token: await nextVisitToken(scope.practiceId, locationFrom(scope), date),
    reason: options.reason ?? '',
    status: 'waiting',
    statusChangedAt: now,
    vitalsRecordedAt: null,
    addedBy: scope.actorId,
  });

  /**
   * The patients list sorts by this and shows "Today" or "Yesterday" from it.
   * $max rather than a plain set, so a visit the PA backdates cannot drag a
   * patient's last-seen date backwards.
   */
  await Patient.updateOne({ _id: patient._id, practiceId: scope.practiceId }, { $max: { lastVisitDate: date } });

  await writeAudit(scope, {
    action: 'visit.create',
    entity: 'visit',
    entityId: visit._id,
    after: toVisitView(visit, patient),
  });

  return { visit, created: true };
};

/**
 * Move a visit along, recording it and announcing it.
 *
 * One place, so the queue changes the same way whether a human pressed a
 * button or approving a prescription did it. A move to where it already is
 * does nothing rather than filling the audit log with noise.
 */
export const changeVisitStatus = async (scope: Scope, visit: VisitDoc, to: VisitStatus): Promise<VisitDoc> => {
  const from = visit.status;
  if (from === to) {
    return visit;
  }

  // statusChangedAt and not updatedAt: that moves when anything changes, and
  // the queue wants to say "went in 6 minutes ago", not "was touched 6
  // minutes ago".
  const updated = await Visit.findOneAndUpdate(
    { _id: visit._id, practiceId: scope.practiceId, deletedAt: null },
    { $set: { status: to, statusChangedAt: new Date() } },
    { new: true },
  );
  if (!updated) {
    throw AppError.notFound('Visit');
  }

  await writeAudit(scope, {
    action: 'visit.update',
    entity: 'visit',
    entityId: visit._id,
    before: { status: from },
    after: { status: to },
  });
  emit('visit.statusChanged', {
    practiceId: scope.practiceId,
    locationId: visit.locationId,
    visitId: visit._id,
    from,
    to,
    actorId: scope.actorId,
  });

  return updated;
};

export const createVisit = async (scope: Scope, body: CreateVisitBody): Promise<VisitView> => {
  const patient = await Patient.findOne({ _id: body.patientId, practiceId: scope.practiceId, deletedAt: null });
  if (!patient) {
    throw AppError.notFound('Patient');
  }

  const { visit } = await ensureVisit(scope, patient, { date: body.date, reason: body.reason });
  return toVisitView(visit, patient);
};

export const updateVisit = async (scope: Scope, id: string, patch: UpdateVisitBody): Promise<VisitView> => {
  const found = await visits.findByIdOrFail(scope, id, 'Visit');
  const visit = await changeVisitStatus(scope, found, patch.status);

  const patient = await Patient.findById(visit.patientId);
  return toVisitView(visit, patient);
};

export default { listVisits, createVisit, updateVisit, ensureVisit, changeVisitStatus };
