import { Patient, Visit, type IVisit, type PatientDoc, type VisitDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { CreateVisitBody, ListVisitsQuery, UpdateVisitBody, VisitView } from '../shared/visit.schema';
import { todayInKarachi } from '../utils/time';
import { toPatientView } from './patient.service';

const visits = new BaseRepository<IVisit>(Visit, { locationScoped: true });

const toVisitView = (visit: VisitDoc, patient: PatientDoc | null): VisitView => ({
  id: String(visit._id),
  locationId: String(visit.locationId),
  patientId: String(visit.patientId),
  patient: patient ? toPatientView(patient) : null,
  date: visit.date,
  status: visit.status,
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
  // second visit, so the existing row comes back untouched.
  const existing = await visits.findOne(scope, { patientId: patient._id, date });
  if (existing) {
    return toVisitView(existing, patient);
  }

  const visit = await visits.create(scope, {
    patientId: patient._id,
    date,
    status: 'waiting',
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
