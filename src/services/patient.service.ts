import { Patient, type IPatient, type PatientDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { CreatePatientBody, PatientView, SearchPatientsQuery, UpdatePatientBody } from '../shared/patient.schema';
import type { PageMeta } from '../shared/response';
import { ageFromDob } from '../utils/time';
import { nextMrNo } from './counter.service';

const patients = new BaseRepository<IPatient>(Patient);

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
});

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const looksLikePhone = (q: string): boolean => /^\+?\d{3,}$/.test(q);

/** `MR-10001`, `mr10001` or just `10001`, as typed at a busy desk. */
const MR_QUERY = /^mr-?(\d+)$/i;
const asMrNo = (q: string): string | null => {
  const prefixed = MR_QUERY.exec(q);
  if (prefixed) return `MR-${prefixed[1]}`;
  return /^\d+$/.test(q) ? `MR-${q}` : null;
};

/**
 * Practice-wide on purpose. A patient first seen at one location must be
 * findable at the other without being entered twice, which is why this is the
 * one read that is not narrowed by location.
 *
 * A query of digits is treated as a phone prefix; anything else goes to the
 * (practiceId, name) text index.
 */
export const searchPatients = async (
  scope: Scope,
  query: SearchPatientsQuery,
): Promise<{ patients: PatientView[]; meta: PageMeta }> => {
  const { q, page, limit } = query;

  let filter = {};
  if (q) {
    const mrNo = asMrNo(q);
    if (mrNo && !looksLikePhone(q)) {
      // Unambiguously an MR number, because it carried the prefix.
      filter = { mrNo };
    } else if (mrNo) {
      // Bare digits are either, so try both rather than guessing: at the desk
      // "10001" is as likely to be a file number as the start of a phone.
      // A string regex, escaped, and never compiled as a pattern on this side.
      filter = { $or: [{ mrNo }, { phone: { $regex: `^${escapeRegex(q)}` } }] };
    } else if (looksLikePhone(q)) {
      filter = { phone: { $regex: `^${escapeRegex(q)}` } };
    } else {
      filter = { $text: { $search: q } };
    }
  }

  const result = await patients.paginate(scope, filter, { page, limit, sortBy: 'name:asc' });

  return {
    patients: result.results.map(toPatientView),
    meta: {
      page: result.page,
      limit: result.limit,
      total: result.totalResults,
      totalPages: result.totalPages,
    },
  };
};

export const getPatient = async (scope: Scope, id: string): Promise<PatientView> =>
  toPatientView(await patients.findByIdOrFail(scope, id, 'Patient'));

export const createPatient = async (scope: Scope, body: CreatePatientBody): Promise<PatientView> => {
  const patient = await patients.create(scope, {
    mrNo: await nextMrNo(scope.practiceId),
    name: body.name,
    phone: body.phone ?? '',
    dob: body.dob ?? null,
    age: body.dob ? null : (body.age ?? null),
    sex: body.sex,
    allergies: body.allergies,
    noKnownAllergies: body.noKnownAllergies,
    addedBy: scope.actorId,
  });

  const after = toPatientView(patient);
  await writeAudit(scope, { action: 'patient.create', entity: 'patient', entityId: patient._id, after });
  emit('patient.added', { practiceId: scope.practiceId, patientId: patient._id, actorId: scope.actorId });

  return after;
};

export const updatePatient = async (scope: Scope, id: string, patch: UpdatePatientBody): Promise<PatientView> => {
  const patient = await patients.findByIdOrFail(scope, id, 'Patient');
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
  return after;
};

export default { searchPatients, getPatient, createPatient, updatePatient, toPatientView };
