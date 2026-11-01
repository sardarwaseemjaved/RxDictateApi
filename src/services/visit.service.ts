import type { Types } from 'mongoose';
import { Appointment, Counter, Patient, Visit, type IVisit, type PatientDoc, type VisitDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import logger from '../config/logger';
import type {
  CreateVisitBody,
  ListVisitsQuery,
  MoveVisitBody,
  UpdateVisitBody,
  VisitStatus,
  VisitView,
} from '../shared/visit.schema';
import { karachiDayRange, todayInKarachi } from '../utils/time';
import { findPatientOrFail, toPatientView } from './patient.service';
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
  queuePosition: visit.queuePosition,
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

  // The order the assistant set, and the token where two rows share a
  // position - which only a renumbering cut short can leave behind.
  const found = await visits.find(
    scope,
    { date, ...(query.status ? { status: query.status } : {}) },
    {
      sort: { queuePosition: 1, token: 1 },
    },
  );
  return withPatients(found);
};

/**
 * The patient is here, so a booking they had that day at this location has
 * been kept. That is what lets the Schedule show who came.
 *
 * Every booked appointment that day, because one visit covers the patient's
 * whole day at a location. Only ever moved by a visit being created: a visit is
 * never made from an appointment on its own.
 *
 * Not in a transaction with the visit. Nothing in this API uses one, and the
 * standalone mongod that dev and the test suite run cannot. The visit is
 * written first, so a failure here leaves the patient on today's list with
 * the booking still showing as booked: wrong, but visibly so, rather than a
 * booking marked arrived for a patient nobody registered.
 */
const markArrived = async (scope: Scope, visit: VisitDoc): Promise<void> => {
  const { start, end } = karachiDayRange(visit.date);
  const booked = await Appointment.find({
    practiceId: scope.practiceId,
    locationId: visit.locationId,
    patientId: visit.patientId,
    status: 'booked',
    deletedAt: null,
    at: { $gte: start, $lt: end },
  });

  await Promise.all(
    booked.map(async (appointment) => {
      // Still booked at the moment of the write, so a cancellation that landed
      // in between is not undone.
      const arrived = await Appointment.findOneAndUpdate(
        { _id: appointment._id, practiceId: scope.practiceId, status: 'booked' },
        { $set: { status: 'arrived' } },
        { new: true },
      );
      if (arrived) {
        await writeAudit(scope, {
          action: 'appointment.arrive',
          entity: 'appointment',
          entityId: arrived._id,
          locationId: arrived.locationId,
          before: { status: 'booked' },
          after: { status: 'arrived', visitId: String(visit._id) },
        });
        emit('appointment.arrived', {
          practiceId: scope.practiceId,
          locationId: arrived.locationId,
          appointmentId: arrived._id,
          visitId: visit._id,
          actorId: scope.actorId,
        });
      }
    }),
  );
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

  // The token is also where the visit starts on the list. No move ever puts a
  // visit at or past the next token, so the newest is always last; and it is
  // one atomic $inc, so two registrations in the same second can no more share
  // a place than they can share a number.
  const token = await nextVisitToken(scope.practiceId, locationFrom(scope), date);

  const now = new Date();
  const visit = await visits.create(scope, {
    patientId: patient._id,
    date,
    token,
    queuePosition: token,
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
   *
   * The same write links them to this location (see linkPatient), which is
   * what makes a patient who comes to a second location visible to the
   * assistant there.
   */
  await Patient.updateOne(
    { _id: patient._id, practiceId: scope.practiceId },
    { $max: { lastVisitDate: date }, $addToSet: { locationIds: visit.locationId } },
  );

  await writeAudit(scope, {
    action: 'visit.create',
    entity: 'visit',
    entityId: visit._id,
    after: toVisitView(visit, patient),
  });
  emit('visit.added', {
    practiceId: scope.practiceId,
    locationId: visit.locationId,
    visitId: visit._id,
    patientId: patient._id,
    actorId: scope.actorId,
  });

  await markArrived(scope, visit);

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
  const patient = await findPatientOrFail(scope, body.patientId);

  const { visit } = await ensureVisit(scope, patient, { date: body.date, reason: body.reason });
  return toVisitView(visit, patient);
};

/** A visit's status is the only edit it takes, so changeVisitStatus is what announces it. */
export const updateVisit = async (scope: Scope, id: string, patch: UpdateVisitBody): Promise<VisitView> => {
  const found = await visits.findByIdOrFail(scope, id, 'Visit');
  const visit = await changeVisitStatus(scope, found, patch.status);

  const patient = await Patient.findById(visit.patientId);
  return toVisitView(visit, patient);
};

/* ------------------------------------------------------------------ *
 * The order of the list
 * ------------------------------------------------------------------ */

/** Long enough for any one move; short enough that a crashed holder blocks nobody for long. */
const QUEUE_LEASE_MS = 5_000;
/** How long a move waits for somebody else's to finish before giving up. */
const QUEUE_WAIT_MS = 2_000;
const QUEUE_RETRY_MS = 25;

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Take the lease on one day's list at one location, waiting a little for
 * whoever has it. Returns the lease's number, which is what releasing it needs.
 *
 * One atomic findOneAndUpdate on a `counters` row, taken only when it is free or
 * its holder has run out of time. When somebody else holds it the filter
 * misses, the upsert tries to insert a second row for the key, and the unique
 * index refuses: that duplicate-key error is what "busy" looks like here.
 */
const takeQueueLease = async (practiceId: Types.ObjectId, key: string): Promise<number> => {
  const giveUpAt = Date.now() + QUEUE_WAIT_MS;
  for (;;) {
    const now = new Date();
    try {
      // eslint-disable-next-line no-await-in-loop
      const lease = await Counter.findOneAndUpdate(
        { practiceId, key, $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
        { $inc: { seq: 1 }, $set: { lockedUntil: new Date(now.getTime() + QUEUE_LEASE_MS) } },
        { new: true, upsert: true },
      );
      return lease.seq;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) {
        throw error;
      }
      if (Date.now() > giveUpAt) {
        throw new AppError('CONFLICT', 'Someone else is rearranging this list. Try again in a moment.');
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(QUEUE_RETRY_MS);
  }
};

/**
 * Run `work` holding the lease on one day's list at one location, so two people
 * rearranging it take turns rather than each working from positions the other
 * is about to change.
 *
 * In place of a transaction, which the standalone mongod that dev, the test
 * suite and a single-box deployment run cannot open. What it does not give is
 * all-or-nothing: a process that dies part way through a renumbering leaves
 * some rows renumbered and some not. The list still reads in a stable order -
 * ties fall back to the token - and the next move renumbers it whole again.
 */
const withQueueLease = async <T>(
  practiceId: Types.ObjectId,
  locationId: Types.ObjectId,
  date: string,
  work: () => Promise<T>,
): Promise<T> => {
  const key = `visitQueue:${String(locationId)}:${date}`;
  const lease = await takeQueueLease(practiceId, key);
  try {
    return await work();
  } finally {
    // Only if it is still ours: a holder that overran its time must not free
    // the lease somebody else has since taken.
    await Counter.updateOne({ practiceId, key, seq: lease }, { $set: { lockedUntil: null } }).catch((error: Error) => {
      // It runs out on its own; nothing is lost but a few seconds.
      logger.warn(`could not release ${key}: ${error.message}`);
    });
  }
};

/**
 * A position strictly between the two neighbours a visit is going in between,
 * or null when they are too close for one to exist.
 *
 * At the front there is nobody below, and one less than the first will do. At
 * the end the ceiling is the next whole number above the last, because no
 * position may reach the next token to be handed out: that is what keeps a new
 * visit, which starts at its token, after everybody already on the list.
 */
const positionBetween = (lower: number | undefined, upper: number | undefined): number | null => {
  if (lower === undefined) {
    return upper === undefined ? 1 : upper - 1;
  }
  const ceiling = upper ?? Math.floor(lower) + 1;
  const middle = (lower + ceiling) / 2;
  return middle > lower && middle < ceiling ? middle : null;
};

/** A visit with the doctor or already seen keeps its place: that part of the list has moved on. */
const notWaiting = (visit: VisitDoc, message: string): AppError =>
  new AppError('CONFLICT', message, { visitId: String(visit._id), status: visit.status });

/**
 * Put a waiting visit just before another, or after every other waiting visit.
 *
 * The assistant calls patients in, so the assistant decides who goes next: a
 * frail patient first, someone who stepped out last. The doctor's screens read
 * the same order. The token never changes - a number out of sequence is how
 * the room can see the list was rearranged, and the patient's slip already
 * says it.
 *
 * Usually one row is written: the visit takes a position halfway between its
 * new neighbours, with every other visit left where it is. Only when there is
 * no number left between them is the whole day numbered again from 1, which
 * stays below the next token because a list never holds more visits than
 * tokens it has handed out.
 *
 * What cannot change - which visits these are, and the day and location they
 * belong to - is checked first. Whether they are still waiting is checked
 * again under the lease, against the list as it is now, because somebody may
 * have called one of them in while this request was on its way.
 */
export const moveVisit = async (scope: Scope, id: string, body: MoveVisitBody): Promise<VisitView> => {
  const visit = await visits.findByIdOrFail(scope, id, 'Visit');

  if (body.before !== null && visit._id.equals(body.before)) {
    throw new AppError('VALIDATION_ERROR', 'A visit cannot be moved before itself.', [
      { field: 'body.before', message: 'must be a different visit' },
    ]);
  }

  const anchor = body.before === null ? null : await visits.findByIdOrFail(scope, body.before, 'Visit');
  if (anchor && (anchor.date !== visit.date || !anchor.locationId.equals(visit.locationId))) {
    throw new AppError('VALIDATION_ERROR', 'Both visits have to be on the same list: the same day at the same location.', [
      { field: 'body.before', message: `is on the list for ${anchor.date}, not ${visit.date}` },
    ]);
  }

  const moved = await withQueueLease(scope.practiceId, visit.locationId, visit.date, async () => {
    const list = await visits.find(scope, { date: visit.date }, { sort: { queuePosition: 1, token: 1 } });

    const self = list.find((row) => row._id.equals(visit._id));
    const target = anchor ? list.find((row) => row._id.equals(anchor._id)) : undefined;
    if (!self || (anchor && !target)) {
      throw AppError.notFound('Visit');
    }
    if (self.status !== 'waiting') {
      throw notWaiting(self, 'Only a patient who is still waiting can be moved.');
    }
    if (target && target.status !== 'waiting') {
      throw notWaiting(target, 'A patient can only be moved before somebody who is still waiting.');
    }

    // Already there: right before that visit among the waiting, or already the
    // last of them. Nothing is written and nothing is audited.
    const waiting = list.filter((row) => row.status === 'waiting');
    const following = waiting[waiting.indexOf(self) + 1];
    if (target ? following === target : following === undefined) {
      return { visit: self, from: self.queuePosition, changed: false };
    }

    const others = list.filter((row) => row !== self);
    const at = target ? others.indexOf(target) : others.length;
    const position = positionBetween(others[at - 1]?.queuePosition, others[at]?.queuePosition);

    if (position !== null) {
      const updated = await Visit.findOneAndUpdate(
        { _id: self._id, practiceId: scope.practiceId, deletedAt: null, status: 'waiting' },
        { $set: { queuePosition: position } },
        { new: true },
      );
      if (!updated) {
        throw new AppError('CONFLICT', 'That patient was called in while being moved. Refresh the list.');
      }
      return { visit: updated, from: self.queuePosition, changed: true };
    }

    const order = [...others.slice(0, at), self, ...others.slice(at)];
    const writes = order.flatMap((row, index) =>
      row.queuePosition === index + 1
        ? []
        : [
            {
              updateOne: {
                filter: { _id: row._id, practiceId: scope.practiceId },
                update: { $set: { queuePosition: index + 1 } },
              },
            },
          ],
    );
    if (writes.length > 0) {
      await Visit.bulkWrite(writes);
    }
    const renumbered = await visits.findByIdOrFail(scope, self._id, 'Visit');
    return { visit: renumbered, from: self.queuePosition, changed: true };
  });

  if (moved.changed) {
    await writeAudit(scope, {
      action: 'visit.move',
      entity: 'visit',
      entityId: visit._id,
      locationId: visit.locationId,
      before: { queuePosition: moved.from },
      after: { queuePosition: moved.visit.queuePosition, movedBefore: body.before },
    });
    emit('visit.moved', {
      practiceId: scope.practiceId,
      locationId: visit.locationId,
      visitId: visit._id,
      actorId: scope.actorId,
    });
  }

  const patient = await Patient.findById(visit.patientId);
  return toVisitView(moved.visit, patient);
};

/**
 * Give every visit from before queuePosition existed the place its token gives
 * it, so each list keeps exactly the order it already had. Runs at boot, after
 * the indexes. Only rows without the field are touched, so a second run does
 * nothing.
 *
 * On the driver's collection rather than through the model: the value is read
 * from each row's own token, which takes an update pipeline.
 */
export const backfillQueuePositions = async (): Promise<number> => {
  const result = await Visit.collection.updateMany({ queuePosition: { $exists: false } }, [
    { $set: { queuePosition: '$token' } },
  ]);
  return result.modifiedCount;
};

export default {
  listVisits,
  createVisit,
  updateVisit,
  moveVisit,
  ensureVisit,
  changeVisitStatus,
  backfillQueuePositions,
};
