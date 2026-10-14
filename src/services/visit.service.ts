import { Patient, Visit, type IVisit, type PatientDoc, type VisitDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { CreateVisitBody, ListVisitsQuery, UpdateVisitBody, VisitView } from '../shared/visit.schema';
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

export const createVisit = async (scope: Scope, body: CreateVisitBody): Promise<VisitView> => {
  const patient = await Patient.findOne({ _id: body.patientId, practiceId: scope.practiceId, deletedAt: null });
  if (!patient) {
    throw AppError.notFound('Patient');
  }

  const date = body.date ?? todayInKarachi();

  // Adding the same patient to the same day twice is a double tap, not a
  // second visit, so the existing row comes back untouched - and no token is
  // spent on it.
  const existing = await visits.findOne(scope, { patientId: patient._id, date });
  if (existing) {
    return toVisitView(existing, patient);
  }

  const now = new Date();
  const visit = await visits.create(scope, {
    patientId: patient._id,
    date,
    token: await nextVisitToken(scope.practiceId, locationFrom(scope), date),
    reason: body.reason,
    status: 'waiting',
    statusChangedAt: now,
    vitalsRecordedAt: null,
    addedBy: scope.actorId,
  });

  const after = toVisitView(visit, patient);
  await writeAudit(scope, { action: 'visit.create', entity: 'visit', entityId: visit._id, after });
  return after;
};

export const updateVisit = async (scope: Scope, id: string, patch: UpdateVisitBody): Promise<VisitView> => {
  const visit = await visits.findByIdOrFail(scope, id, 'Visit');
  const from = visit.status;

  if (from !== patch.status) {
    visit.status = patch.status;
    // Not updatedAt: that moves when anything changes, and the queue wants to
    // say "went in 6 minutes ago", not "was touched 6 minutes ago".
    visit.statusChangedAt = new Date();
    await visit.save();

    await writeAudit(scope, {
      action: 'visit.update',
      entity: 'visit',
      entityId: visit._id,
      before: { status: from },
      after: { status: visit.status },
    });
    emit('visit.statusChanged', {
      practiceId: scope.practiceId,
      locationId: visit.locationId,
      visitId: visit._id,
      from,
      to: visit.status,
      actorId: scope.actorId,
    });
  }

  const patient = await Patient.findById(visit.patientId);
  return toVisitView(visit, patient);
};

export default { listVisits, createVisit, updateVisit };
