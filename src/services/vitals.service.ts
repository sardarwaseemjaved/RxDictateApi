import { Visit, Vital, type VitalDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { IVisit } from '../models/visit.model';
import { vitalFlags, type RecordVitalsBody, type VitalsView } from '../shared/vitals.schema';

const visits = new BaseRepository<IVisit>(Visit, { locationScoped: true });

export const toVitalsView = (vitals: VitalDoc): VitalsView => ({
  id: String(vitals._id),
  visitId: String(vitals.visitId),
  bp: vitals.bp,
  pulse: vitals.pulse,
  tempF: vitals.tempF,
  weightKg: vitals.weightKg,
  spo2: vitals.spo2,
  bloodSugarRandom: vitals.bloodSugarRandom,
  complaints: vitals.complaints,
  recordedBy: String(vitals.recordedBy),
  recordedAt: vitals.recordedAt,
});

/**
 * The visit has to be one of this practice's, at a location this caller may
 * work at. Going through the repository is what guarantees both.
 */
const loadVisit = async (scope: Scope, visitId: string) => visits.findByIdOrFail(scope, visitId, 'Visit');

export const getVitals = async (scope: Scope, visitId: string): Promise<VitalsView> => {
  const visit = await loadVisit(scope, visitId);

  const vitals = await Vital.findOne({ visitId: visit._id, practiceId: scope.practiceId, deletedAt: null });
  if (!vitals) {
    throw AppError.notFound('Vitals for this visit');
  }
  return toVitalsView(vitals);
};

/**
 * Create or replace the one set of readings for a visit.
 *
 * A PUT rather than a POST because there is exactly one: a correction to a
 * reading taken two minutes ago is a correction, not a second set of
 * observations. The previous values go into the audit entry, so an amended
 * blood pressure is still explicable afterwards.
 */
export const recordVitals = async (scope: Scope, visitId: string, body: RecordVitalsBody): Promise<VitalsView> => {
  const visit = await loadVisit(scope, visitId);

  const existing = await Vital.findOne({ visitId: visit._id, practiceId: scope.practiceId });
  const before = existing ? toVitalsView(existing) : null;
  const recordedAt = new Date();

  const values = {
    practiceId: scope.practiceId,
    visitId: visit._id,
    bp: body.bp ?? null,
    pulse: body.pulse ?? null,
    tempF: body.tempF ?? null,
    weightKg: body.weightKg ?? null,
    spo2: body.spo2 ?? null,
    bloodSugarRandom: body.bloodSugarRandom ?? null,
    complaints: body.complaints,
    recordedBy: scope.actorId,
    recordedAt,
    createdBy: existing?.createdBy ?? scope.actorId,
    deletedAt: null,
  };

  const vitals = await Vital.findOneAndUpdate(
    { visitId: visit._id, practiceId: scope.practiceId },
    { $set: values },
    {
      new: true,
      upsert: true,
    },
  );

  // What the queue reads to show "Vitals done" instead of "Add vitals".
  visit.vitalsRecordedAt = recordedAt;
  await visit.save();

  const after = toVitalsView(vitals);
  // The same function the app highlights with, so the two cannot disagree in
  // front of a patient.
  const flags = vitalFlags(after);

  await writeAudit(scope, {
    action: 'vitals.record',
    entity: 'vital',
    entityId: vitals._id,
    before,
    after: { ...after, flagged: flags.map((flag) => flag.field) },
  });

  emit('vitals.recorded', {
    practiceId: scope.practiceId,
    locationId: visit.locationId,
    visitId: visit._id,
    patientId: visit.patientId,
    flaggedFields: flags.map((flag) => flag.field),
    actorId: scope.actorId,
  });

  return after;
};

export default { getVitals, recordVitals, toVitalsView };
