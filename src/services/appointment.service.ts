import { Types } from 'mongoose';
import { Appointment, Patient, Prescription, type AppointmentDoc, type IAppointment, type PatientDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type {
  AppointmentCountsByDay,
  AppointmentView,
  CreateAppointmentBody,
  FollowUpView,
  ListAppointmentsQuery,
  ListFollowUpsQuery,
} from '../shared/appointment.schema';
import type { PageMeta } from '../shared/response';
import { addDays, karachiDay, karachiDayRange, todayInKarachi } from '../utils/time';
import { toPatientView } from './patient.service';

const appointments = new BaseRepository<IAppointment>(Appointment, { locationScoped: true });

const toAppointmentView = (appointment: AppointmentDoc, patient: PatientDoc | null): AppointmentView => ({
  id: String(appointment._id),
  locationId: String(appointment.locationId),
  patient: patient ? toPatientView(patient) : null,
  at: appointment.at,
  kind: appointment.kind,
  status: appointment.status,
  note: appointment.note,
  prescriptionId: appointment.prescriptionId ? String(appointment.prescriptionId) : null,
});

/** One query for the page rather than one per row. */
const withPatients = async (found: AppointmentDoc[]): Promise<AppointmentView[]> => {
  const patients = await Patient.find({ _id: { $in: found.map((appointment) => appointment.patientId) } });
  const byId = new Map(patients.map((patient) => [String(patient._id), patient]));
  return found.map((appointment) => toAppointmentView(appointment, byId.get(String(appointment.patientId)) ?? null));
};

/**
 * The booked appointments between two Karachi days, inclusive.
 *
 * `countsByDay` is over the same range and is what the seven-day strip above
 * the list renders, so it is counted here rather than by the app paging
 * through everything to add them up.
 */
export const listAppointments = async (
  scope: Scope,
  query: ListAppointmentsQuery,
): Promise<{ appointments: AppointmentView[]; meta: { countsByDay: AppointmentCountsByDay; total: number } }> => {
  const { start } = karachiDayRange(query.from);
  const { end } = karachiDayRange(query.to);

  const found = await appointments.find(scope, { at: { $gte: start, $lt: end }, status: 'booked' }, { sort: { at: 1 } });

  const countsByDay: AppointmentCountsByDay = {};
  found.forEach((appointment) => {
    const day = karachiDay(appointment.at);
    countsByDay[day] = (countsByDay[day] ?? 0) + 1;
  });

  return { appointments: await withPatients(found), meta: { countsByDay, total: found.length } };
};

export const createAppointment = async (scope: Scope, body: CreateAppointmentBody): Promise<AppointmentView> => {
  const patient = await Patient.findOne({ _id: body.patientId, practiceId: scope.practiceId, deletedAt: null });
  if (!patient) {
    throw AppError.notFound('Patient');
  }

  if (body.prescriptionId) {
    const prescription = await Prescription.findOne({
      _id: body.prescriptionId,
      practiceId: scope.practiceId,
      deletedAt: null,
    });
    if (!prescription) {
      throw AppError.notFound('Prescription');
    }
  }

  try {
    const appointment = await appointments.create(scope, {
      patientId: patient._id,
      at: body.at,
      kind: body.kind,
      status: 'booked',
      note: body.note,
      prescriptionId: body.prescriptionId ? new Types.ObjectId(body.prescriptionId) : null,
      cancelledAt: null,
    });

    const after = toAppointmentView(appointment, patient);
    await writeAudit(scope, {
      action: 'appointment.create',
      entity: 'appointment',
      entityId: appointment._id,
      after,
    });
    emit('appointment.booked', {
      practiceId: scope.practiceId,
      locationId: appointment.locationId,
      appointmentId: appointment._id,
      patientId: patient._id,
      at: appointment.at,
      actorId: scope.actorId,
    });

    return after;
  } catch (error) {
    // The unique partial index is what actually decides this, so two people
    // booking the same slot at the same moment cannot both win.
    if ((error as { code?: number }).code === 11000) {
      throw new AppError('CONFLICT', 'That slot is already booked.');
    }
    throw error;
  }
};

export const cancelAppointment = async (scope: Scope, id: string): Promise<AppointmentView> => {
  const appointment = await appointments.findByIdOrFail(scope, id, 'Appointment');

  if (appointment.status === 'cancelled') {
    const patient = await Patient.findById(appointment.patientId);
    return toAppointmentView(appointment, patient);
  }

  const before = { status: appointment.status };
  appointment.status = 'cancelled';
  appointment.cancelledAt = new Date();
  await appointment.save();

  const patient = await Patient.findById(appointment.patientId);
  const after = toAppointmentView(appointment, patient);

  await writeAudit(scope, {
    action: 'appointment.cancel',
    entity: 'appointment',
    entityId: appointment._id,
    before,
    after: { status: after.status },
  });
  emit('appointment.cancelled', {
    practiceId: scope.practiceId,
    locationId: appointment.locationId,
    appointmentId: appointment._id,
    actorId: scope.actorId,
  });

  return after;
};

/**
 * The follow-ups the doctor asked for that nobody has booked.
 *
 * Derived rather than stored: an approved prescription whose followUp has a
 * date, with no booked appointment pointing back at it. Booking one with its
 * prescriptionId is what removes it from here, so there is no second list to
 * keep in step and nothing to go stale.
 */
export const listFollowUps = async (
  scope: Scope,
  query: ListFollowUpsQuery,
): Promise<{ followUps: FollowUpView[]; meta: PageMeta }> => {
  const prescriptions = await Prescription.find({
    practiceId: scope.practiceId,
    ...(scope.locationId ? { locationId: scope.locationId } : {}),
    status: 'approved',
    deletedAt: null,
    $or: [{ 'sections.followUp.date': { $ne: null } }, { 'sections.followUp.inDays': { $ne: null } }],
  }).sort({ approvedAt: -1 });

  // One query rather than one per prescription.
  const booked = await Appointment.find({
    practiceId: scope.practiceId,
    status: 'booked',
    prescriptionId: { $in: prescriptions.map((prescription) => prescription._id) },
  }).select('prescriptionId');
  const bookedFor = new Set(booked.map((appointment) => String(appointment.prescriptionId)));

  const today = todayInKarachi();

  const unbooked = prescriptions.filter((prescription) => !bookedFor.has(String(prescription._id)));
  const patients = await Patient.find({ _id: { $in: unbooked.map((prescription) => prescription.patientId) } });
  const byId = new Map(patients.map((patient) => [String(patient._id), patient]));

  const all = unbooked
    .map((prescription) => {
      const { followUp } = prescription.sections;
      // An explicit date wins; otherwise it is counted from the day the
      // prescription was signed, which is the day the doctor said "come back
      // in ten days".
      const dueDate =
        followUp.date ??
        (followUp.inDays !== null && prescription.approvedAt
          ? karachiDay(addDays(prescription.approvedAt, followUp.inDays))
          : null);
      if (!dueDate) return null;

      return {
        prescriptionId: String(prescription._id),
        patient: byId.has(String(prescription.patientId)) ? toPatientView(byId.get(String(prescription.patientId))!) : null,
        dueDate,
        note: followUp.note,
        isOverdue: dueDate < today,
      } satisfies FollowUpView;
    })
    .filter((item): item is FollowUpView => item !== null)
    // Soonest first, so the overdue ones are at the top where they belong.
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const start = (query.page - 1) * query.limit;
  return {
    followUps: all.slice(start, start + query.limit),
    meta: {
      page: query.page,
      limit: query.limit,
      total: all.length,
      totalPages: Math.max(1, Math.ceil(all.length / query.limit)),
    },
  };
};

export default { listAppointments, createAppointment, cancelAppointment, listFollowUps };
