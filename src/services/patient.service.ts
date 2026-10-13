import { Patient, type IPatient, type PatientDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { CreatePatientBody, PatientView, SearchPatientsQuery, UpdatePatientBody } from '../shared/patient.schema';
import type { PageMeta } from '../shared/response';
import { ageFromDob } from '../utils/time';

const patients = new BaseRepository<IPatient>(Patient);

/** Age comes from the date of birth when there is one, and from what was typed otherwise. */
export const toPatientView = (patient: PatientDoc): PatientView => ({
  id: String(patient._id),
  name: patient.name,
  phone: patient.phone,
  dob: patient.dob,
  age: patient.dob ? ageFromDob(patient.dob) : patient.age,
  sex: patient.sex,
});

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const looksLikePhone = (q: string): boolean => /^\+?\d{3,}$/.test(q);

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
    // A string regex rather than a RegExp object: escaped, and never compiled
    // as a pattern on this side.
    filter = looksLikePhone(q) ? { phone: { $regex: `^${escapeRegex(q)}` } } : { $text: { $search: q } };
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
    name: body.name,
    phone: body.phone ?? '',
    dob: body.dob ?? null,
    age: body.dob ? null : (body.age ?? null),
    sex: body.sex,
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

  await patient.save();
  const after = toPatientView(patient);

  await writeAudit(scope, { action: 'patient.update', entity: 'patient', entityId: patient._id, before, after });
  return after;
};

export default { searchPatients, getPatient, createPatient, updatePatient, toPatientView };
