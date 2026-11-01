import { Types } from 'mongoose';
import {
  Appointment,
  Location,
  Membership,
  Patient,
  PatientIntroduction,
  Prescription,
  Report,
  Visit,
  type IPatient,
  type PatientDoc,
} from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import { phoneSchema } from '../shared/common';
import type {
  CreatePatientBody,
  PatientListMeta,
  PatientSummary,
  PatientView,
  SearchPatientsQuery,
  UpdatePatientBody,
} from '../shared/patient.schema';
import { escapeRegex } from '../utils/regex';
import { addDays, ageFromDob, karachiDay, todayInKarachi } from '../utils/time';
import { nextMrNo } from './counter.service';

const patients = new BaseRepository<IPatient>(Patient);

/* ------------------------------------------------------------------ *
 * Who sees which patients
 *
 * A patient belongs to the practice and is linked to locations: where they
 * were registered, and wherever they have had a visit or an appointment. The
 * doctor sees the whole practice. An assistant sees the patients linked to a
 * location they work at, and nobody else - a patient outside them is
 * NOT_FOUND, never FORBIDDEN, because whether they exist is not that
 * assistant's business.
 *
 * Every service that reaches a patient goes through findPatient or
 * visiblePatients below, so the rule lives here and nowhere else.
 * ------------------------------------------------------------------ */

/** How long finding a patient by their whole phone number lets an assistant reach them. */
export const INTRODUCTION_MS = 30 * 60 * 1000;

/**
 * The patients a member may see, as a filter: everyone for the doctor, and for
 * an assistant those linked to at least one of their locations.
 *
 * The locations come from the membership, which is read on every request, so
 * taking a location away from an assistant hides its patients at once.
 */
export const visiblePatients = (scope: Scope): Record<string, unknown> =>
  scope.allowedLocationIds === 'all' ? {} : { locationIds: { $in: scope.allowedLocationIds } };

/**
 * The rule itself, on its own: a member reaching every location sees every
 * patient, and anyone else sees the ones linked to a location of theirs. Also
 * decides who hears about a patient over the realtime socket.
 */
export const canSeePatient = (allowed: Types.ObjectId[] | 'all', linkedTo: Types.ObjectId[]): boolean =>
  allowed === 'all' || linkedTo.some((id) => allowed.some((mine) => mine.equals(id)));

const isLinked = (scope: Scope, patient: PatientDoc): boolean =>
  canSeePatient(scope.allowedLocationIds, patient.locationIds);

/** Found by this member, by their whole phone number, within the last INTRODUCTION_MS. */
const wasIntroduced = async (scope: Scope, patientId: Types.ObjectId): Promise<boolean> =>
  (await PatientIntroduction.exists({
    practiceId: scope.practiceId,
    userId: scope.actorId,
    patientId,
    expiresAt: { $gt: new Date() },
  })) !== null;

/**
 * The one way to reach a patient by id: in this practice, not deleted, and one
 * this member may see - linked to one of their locations, or found by their
 * whole phone number a moment ago. Null otherwise, with no hint which.
 */
export const findPatient = async (scope: Scope, id: Types.ObjectId | string): Promise<PatientDoc | null> => {
  const patient = await patients.findById(scope, id);
  if (!patient) {
    return null;
  }
  if (isLinked(scope, patient) || (await wasIntroduced(scope, patient._id))) {
    return patient;
  }
  return null;
};

/** findPatient, with a miss as NOT_FOUND. */
export const findPatientOrFail = async (scope: Scope, id: Types.ObjectId | string): Promise<PatientDoc> => {
  const patient = await findPatient(scope, id);
  if (!patient) {
    throw AppError.notFound('Patient');
  }
  return patient;
};

/**
 * Link a patient to a location. Only ever adds: a patient seen at a location
 * stays findable there, the way their file would stay in that location's
 * cabinet.
 */
export const linkPatient = async (
  practiceId: Types.ObjectId,
  patientId: Types.ObjectId,
  locationId: Types.ObjectId,
): Promise<void> => {
  await Patient.updateOne({ _id: patientId, practiceId }, { $addToSet: { locationIds: locationId } });
};

/**
 * Where a new patient is registered: the location the request names, when it
 * is one the caller works at. Without one, an assistant's own locations - so
 * they can find the patient they have just added - and for the doctor the
 * practice's default location.
 */
const registeredAt = async (scope: Scope): Promise<Types.ObjectId[]> => {
  if (scope.locationId) {
    return [scope.locationId];
  }
  if (scope.allowedLocationIds !== 'all') {
    return scope.allowedLocationIds;
  }
  const main = await Location.findOne({
    practiceId: scope.practiceId,
    isDefault: true,
    status: 'active',
    deletedAt: null,
  }).select('_id');
  return main ? [main._id] : [];
};

/** A whole number in the form the record holds it, not the start of one. */
const isWholePhone = (q: string): boolean => phoneSchema.safeParse(q).success;

/**
 * Note that this member found these patients by their whole phone number, for
 * the ones not linked to anywhere they work. Searching again extends it.
 */
const introduce = async (scope: Scope, found: PatientDoc[]): Promise<void> => {
  const strangers = found.filter((patient) => !isLinked(scope, patient));
  if (strangers.length === 0) {
    return;
  }

  const expiresAt = new Date(Date.now() + INTRODUCTION_MS);
  try {
    await PatientIntroduction.bulkWrite(
      strangers.map((patient) => ({
        updateOne: {
          filter: { practiceId: scope.practiceId, userId: scope.actorId, patientId: patient._id },
          update: { $set: { expiresAt } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (error) {
    // Two searches at once can both insert the same row. One wins on the
    // unique index, and the other's expiry would have been the same.
    if ((error as { code?: number }).code !== 11000) {
      throw error;
    }
  }
};

/** Both filters, without one's $or overwriting the other's. */
const allOf = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> =>
  '$or' in a && '$or' in b ? { $and: [a, b] } : { ...a, ...b };

/** Age comes from the date of birth when there is one, and from what was typed otherwise. */
export const toPatientView = (patient: PatientDoc): PatientView => ({
  id: String(patient._id),
  mrNo: patient.mrNo,
  name: patient.name,
  phone: patient.phone,
  dob: patient.dob,
  age: patient.dob ? ageFromDob(patient.dob) : patient.age,
  sex: patient.sex,
  allergies: patient.allergies,
  noKnownAllergies: patient.noKnownAllergies,
  conditions: patient.conditions,
  lastVisitDate: patient.lastVisitDate,
});

/** The fields a list row needs, read the same way as the full view. */
export const toPatientSummary = (patient: PatientDoc): PatientSummary => {
  const { id, mrNo, name, age, sex } = toPatientView(patient);
  return { id, mrNo, name, age, sex };
};

const looksLikePhone = (q: string): boolean => /^\+?\d{3,}$/.test(q);

/** `MR-10001`, `mr10001` or just `10001`, as typed at a busy desk. */
const MR_QUERY = /^mr-?(\d+)$/i;
const asMrNo = (q: string): string | null => {
  const prefixed = MR_QUERY.exec(q);
  if (prefixed) return `MR-${prefixed[1]}`;
  return /^\d+$/.test(q) ? `MR-${q}` : null;
};

/**
 * What a typed `q` matches: a name, an MR number (with or without the prefix,
 * in any case) or the start of a phone number. A query of digits is treated as
 * a phone prefix; anything else goes to the (practiceId, name) text index.
 *
 * Shared by patient search and the prescriptions list, so "find Fatima" finds
 * the same people on both screens.
 */
export const patientMatch = (q: string): Record<string, unknown> => {
  const mrNo = asMrNo(q);
  if (mrNo && !looksLikePhone(q)) {
    // Unambiguously an MR number, because it carried the prefix.
    return { mrNo };
  }
  if (mrNo) {
    // Bare digits are either, so try both rather than guessing: at the desk
    // "10001" is as likely to be a file number as the start of a phone.
    // A string regex, escaped, and never compiled as a pattern on this side.
    return { $or: [{ mrNo }, { phone: { $regex: `^${escapeRegex(q)}` } }] };
  }
  if (looksLikePhone(q)) {
    return { phone: { $regex: `^${escapeRegex(q)}` } };
  }
  return { $text: { $search: q } };
};

/**
 * The patients whose follow-up has come and gone.
 *
 * An approved prescription asked them back on a date that has now passed, and
 * they have not been in since. Worked out from the prescriptions rather than
 * stored, so it cannot go stale, and bounded: one query for the practice's
 * pending follow-ups, one for the patients they name.
 */
const followUpDueIds = async (scope: Scope): Promise<Types.ObjectId[]> => {
  const today = todayInKarachi();

  const asked = await Prescription.find({
    practiceId: scope.practiceId,
    status: 'approved',
    deletedAt: null,
    $or: [{ 'sections.followUp.date': { $ne: null } }, { 'sections.followUp.inDays': { $ne: null } }],
  }).select('patientId sections.followUp approvedAt');

  // The most recent instruction wins: a later prescription saying "in a month"
  // supersedes an earlier one that said "in a week".
  const dueBy = new Map<string, string>();
  asked.forEach((prescription) => {
    const { followUp } = prescription.sections;
    const dueDate =
      followUp.date ??
      (followUp.inDays !== null && prescription.approvedAt
        ? karachiDay(addDays(prescription.approvedAt, followUp.inDays))
        : null);
    if (!dueDate || dueDate > today) {
      return;
    }
    const key = String(prescription.patientId);
    const known = dueBy.get(key);
    if (!known || dueDate > known) {
      dueBy.set(key, dueDate);
    }
  });

  if (dueBy.size === 0) {
    return [];
  }

  const candidates = await Patient.find({
    _id: { $in: [...dueBy.keys()].map((id) => new Types.ObjectId(id)) },
    practiceId: scope.practiceId,
    deletedAt: null,
    ...visiblePatients(scope),
  }).select('lastVisitDate');

  return candidates
    .filter((patient) => {
      const due = dueBy.get(String(patient._id))!;
      // Seen on or after the day they were asked back means they came.
      return patient.lastVisitDate === null || patient.lastVisitDate < due;
    })
    .map((patient) => patient._id);
};

/** Patients with a report nobody has marked reviewed, among the ones this member may see. */
const newReportIds = async (scope: Scope): Promise<Types.ObjectId[]> => {
  const withNew: Types.ObjectId[] = await Report.distinct('patientId', {
    practiceId: scope.practiceId,
    reviewedAt: null,
    deletedAt: null,
  });
  if (scope.allowedLocationIds === 'all') {
    return withNew;
  }
  return Patient.distinct('_id', {
    _id: { $in: withNew },
    practiceId: scope.practiceId,
    deletedAt: null,
    ...visiblePatients(scope),
  });
};

/**
 * The practice's patients for the doctor, and an assistant's own (see "Who
 * sees which patients" above). The doctor's search is practice-wide on
 * purpose: a patient first seen at one location is found at the other without
 * being entered twice.
 *
 * `q` is matched by patientMatch above. For an assistant, a whole phone number
 * is the one exception to their locations: it finds the patient wherever they
 * were registered, so the assistant at a second location puts them on the
 * list instead of registering them again - which is what links them there.
 * Only the exact number does this; a prefix still finds only their own.
 *
 * The chip counts ignore `q` and the active filter, because that is what a
 * chip count means: how many there are to look at, not how many of what is
 * already on screen.
 */
export const searchPatients = async (
  scope: Scope,
  query: SearchPatientsQuery,
): Promise<{ patients: PatientView[]; meta: PatientListMeta }> => {
  const { q, sort, page, limit } = query;

  const visible = visiblePatients(scope);
  const byWholePhone = q !== undefined && scope.allowedLocationIds !== 'all' && isWholePhone(q);
  const reach = byWholePhone ? { $or: [visible, { phone: q }] } : visible;
  const filter: Record<string, unknown> = q ? allOf(patientMatch(q), reach) : { ...visible };

  const [due, unreviewed, all] = await Promise.all([
    followUpDueIds(scope),
    newReportIds(scope),
    patients.count(scope, visible),
  ]);

  // Both chips at once means both, so the id sets intersect rather than add.
  const wanted: Types.ObjectId[][] = [];
  if (query.followUpDue) wanted.push(due);
  if (query.newReports) wanted.push(unreviewed);
  if (wanted.length > 0) {
    const asStrings = wanted.map((ids) => new Set(ids.map(String)));
    const both = wanted[0].filter((id) => asStrings.every((set) => set.has(String(id))));
    filter._id = { $in: both };
  }

  const result = await patients.paginate(scope, filter, {
    page,
    limit,
    // Descending puts a patient who has never been in at the bottom, where
    // Mongo sorts nulls last.
    sortBy: sort === 'lastVisit' ? 'lastVisitDate:desc' : 'name:asc',
  });

  if (byWholePhone) {
    await introduce(scope, result.results);
  }

  return {
    patients: result.results.map(toPatientView),
    meta: {
      page: result.page,
      limit: result.limit,
      total: result.totalResults,
      totalPages: result.totalPages,
      counts: { all, followUpDue: due.length, newReports: unreviewed.length },
    },
  };
};

export const getPatient = async (scope: Scope, id: string): Promise<PatientView> =>
  toPatientView(await findPatientOrFail(scope, id));

export const createPatient = async (scope: Scope, body: CreatePatientBody): Promise<PatientView> => {
  const patient = await patients.create(scope, {
    mrNo: await nextMrNo(scope.practiceId),
    locationIds: await registeredAt(scope),
    name: body.name,
    phone: body.phone ?? '',
    dob: body.dob ?? null,
    age: body.dob ? null : (body.age ?? null),
    sex: body.sex,
    allergies: body.allergies,
    noKnownAllergies: body.noKnownAllergies,
    conditions: body.conditions,
    addedBy: scope.actorId,
  });

  const after = toPatientView(patient);
  await writeAudit(scope, { action: 'patient.create', entity: 'patient', entityId: patient._id, after });
  emit('patient.added', { practiceId: scope.practiceId, patientId: patient._id, actorId: scope.actorId });

  return after;
};

export const updatePatient = async (scope: Scope, id: string, patch: UpdatePatientBody): Promise<PatientView> => {
  const patient = await findPatientOrFail(scope, id);
  const before = toPatientView(patient);

  if (patch.name !== undefined) patient.name = patch.name;
  if (patch.phone !== undefined) patient.phone = patch.phone;
  if (patch.sex !== undefined) patient.sex = patch.sex;
  if (patch.dob !== undefined) {
    patient.dob = patch.dob;
    // A real date of birth makes a typed-in age redundant, and keeping both
    // invites them to disagree.
    if (patch.dob !== null) patient.age = null;
  }
  if (patch.age !== undefined && patient.dob === null) {
    patient.age = patch.age;
  }
  if (patch.allergies !== undefined) patient.allergies = patch.allergies;
  if (patch.noKnownAllergies !== undefined) patient.noKnownAllergies = patch.noKnownAllergies;
  if (patch.conditions !== undefined) patient.conditions = patch.conditions;

  /**
   * The body can only check the fields it carries, so the contradiction is
   * caught here against the record as it will end up: listing an allergy in one
   * request and setting "no known allergies" in the next would otherwise leave
   * a chart that says both.
   */
  if (patient.noKnownAllergies && patient.allergies.length > 0) {
    throw new AppError('VALIDATION_ERROR', 'A patient cannot have no known allergies and a list of allergies.');
  }

  await patient.save();
  const after = toPatientView(patient);

  await writeAudit(scope, { action: 'patient.update', entity: 'patient', entityId: patient._id, before, after });
  emit('patient.updated', { practiceId: scope.practiceId, patientId: patient._id, actorId: scope.actorId });
  return after;
};

/**
 * Link every patient written before patients had locations: each location they
 * have had a visit, an appointment or a prescription at.
 *
 * Where they were registered was never recorded, so it is inferred the way a
 * registration without X-Location-Id is decided today. A patient an assistant
 * registered is linked to that assistant's locations, so it does not vanish
 * from the person who added it. A patient linked nowhere by then - registered
 * by the doctor and never seen - goes to the default location, rather than
 * being visible to no assistant at all.
 *
 * Only patients with no locationIds at all are read, so this does nothing
 * once it has run. It writes with $addToSet, so a link a request added in the
 * meantime is kept. Runs on boot, before the first request.
 */
export const backfillPatientLocations = async (): Promise<number> => {
  const unlinked = await Patient.collection
    .find({ locationIds: { $exists: false } }, { projection: { _id: 1, practiceId: 1, addedBy: 1 } })
    .toArray();
  if (unlinked.length === 0) {
    return 0;
  }

  const ids = unlinked.map((patient) => patient._id);
  const linksIn = async (collection: typeof Visit.collection): Promise<Map<string, Types.ObjectId[]>> => {
    const rows = await collection
      .aggregate<{ _id: Types.ObjectId; locationIds: Types.ObjectId[] }>([
        { $match: { patientId: { $in: ids } } },
        { $group: { _id: '$patientId', locationIds: { $addToSet: '$locationId' } } },
      ])
      .toArray();
    return new Map(rows.map((row) => [String(row._id), row.locationIds]));
  };

  const [visits, appointments, prescriptions, assistants, defaults] = await Promise.all([
    linksIn(Visit.collection),
    linksIn(Appointment.collection),
    linksIn(Prescription.collection),
    Membership.find({ userId: { $in: unlinked.map((patient) => patient.addedBy) }, role: 'pa' }).select(
      'practiceId userId locationIds',
    ),
    Location.find({
      practiceId: { $in: unlinked.map((patient) => patient.practiceId) },
      isDefault: true,
      status: 'active',
      deletedAt: null,
    }).select('practiceId'),
  ]);
  const assistantAt = new Map(assistants.map((m) => [`${String(m.practiceId)}:${String(m.userId)}`, m.locationIds]));
  const defaultOf = new Map(defaults.map((location) => [String(location.practiceId), location._id]));

  await Patient.collection.bulkWrite(
    unlinked.map((patient) => {
      const links = new Map<string, Types.ObjectId>();
      const add = (found: Types.ObjectId[] = []) => found.forEach((id) => links.set(String(id), id));

      [visits, appointments, prescriptions].forEach((from) => add(from.get(String(patient._id))));
      add(assistantAt.get(`${String(patient.practiceId)}:${String(patient.addedBy)}`));
      if (links.size === 0 && defaultOf.has(String(patient.practiceId))) {
        add([defaultOf.get(String(patient.practiceId))!]);
      }

      return links.size > 0
        ? {
            updateOne: {
              filter: { _id: patient._id },
              update: { $addToSet: { locationIds: { $each: [...links.values()] } } },
            },
          }
        : {
            updateOne: {
              filter: { _id: patient._id, locationIds: { $exists: false } },
              update: { $set: { locationIds: [] } },
            },
          };
    }),
  );

  return unlinked.length;
};

export default {
  searchPatients,
  getPatient,
  createPatient,
  updatePatient,
  toPatientView,
  toPatientSummary,
  patientMatch,
  visiblePatients,
  canSeePatient,
  findPatient,
  findPatientOrFail,
  linkPatient,
  backfillPatientLocations,
};
