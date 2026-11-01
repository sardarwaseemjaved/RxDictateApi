/**
 * Puts a set of made-up patients into a clinic, for trying the apps with a list
 * that looks like a real one. They are added as the member whose phone is
 * given - a doctor or an assistant of that clinic.
 *
 *   yarn seed:patients --phone +923155025189 --clinic "Health Care" [--count 20] [--today]
 *   node dist/scripts/seedPatients.js --phone ... --clinic ...    (on the server)
 *
 * Writes to the database MONGODB_URL names, through createPatient, so each one
 * gets the clinic's next MR number and an audit row like any patient added at
 * the desk. The listeners are not loaded, so the doctor is not sent twenty
 * "New patient added" notifications.
 *
 * --today also puts every one of them on today's list at the location --clinic
 * names, through createVisit: a token each, in the order of the list below.
 * The member has to work at that location, as they would in the app.
 *
 * Safe to run twice: a patient already in the clinic with the same name and
 * phone is not added again, and one already on today's list keeps their place.
 * The phone numbers are on 0399, which no Pakistani network hands out, so
 * nothing here can belong to a real person.
 */
import mongoose from 'mongoose';
import config from '../config/config';
import logger from '../config/logger';
import { Location, Membership, Patient, Practice, User } from '../models';
import type { Scope } from '../core/db';
import { can } from '../core/permissions';
import { createPatientBodySchema, type CreatePatientBody } from '../shared/patient.schema';
import { createVisitBodySchema } from '../shared/visit.schema';
import { createPatient } from '../services/patient.service';
import { createVisit } from '../services/visit.service';

type Sample = Omit<CreatePatientBody, 'allergies' | 'noKnownAllergies' | 'conditions'> &
  Partial<Pick<CreatePatientBody, 'allergies' | 'noKnownAllergies' | 'conditions'>>;

const SAMPLES: Sample[] = [
  { name: 'Muhammad Asif', phone: '+923990000101', age: 46, sex: 'male', conditions: ['Diabetes'], noKnownAllergies: true },
  { name: 'Ayesha Siddiqui', phone: '+923990000102', dob: '1991-04-17', sex: 'female', allergies: ['Penicillin'] },
  { name: 'Ali Raza', phone: '+923990000103', age: 29, sex: 'male', noKnownAllergies: true },
  { name: 'Fatima Bibi', phone: '+923990000104', age: 63, sex: 'female', conditions: ['Hypertension', 'Diabetes'] },
  // Mother and son on one phone, as families often are at the desk.
  { name: 'Sana Tariq', phone: '+923990000105', age: 34, sex: 'female', noKnownAllergies: true },
  { name: 'Hamza Tariq', phone: '+923990000105', dob: '2019-08-02', sex: 'male', conditions: ['Asthma'] },
  {
    name: 'Ghulam Rasool',
    phone: '+923990000107',
    age: 71,
    sex: 'male',
    conditions: ['Hypertension', 'COPD'],
    allergies: ['Aspirin'],
  },
  { name: 'Zainab Hussain', phone: '+923990000108', age: 22, sex: 'female', noKnownAllergies: true },
  { name: 'Usman Ghani', phone: '+923990000109', dob: '1985-11-30', sex: 'male', conditions: ['Hypothyroidism'] },
  {
    name: 'Rukhsana Begum',
    phone: '+923990000110',
    age: 58,
    sex: 'female',
    allergies: ['Sulfa drugs'],
    conditions: ['Diabetes'],
  },
  { name: 'Bilal Ahmed', phone: '+923990000111', age: 38, sex: 'male', noKnownAllergies: true },
  { name: 'Mariam Khan', phone: '+923990000112', dob: '2012-02-21', sex: 'female' },
  { name: 'Imran Shah', phone: '+923990000113', age: 52, sex: 'male', conditions: ['Hypertension'], noKnownAllergies: true },
  { name: 'Nida Farooq', phone: '+923990000114', age: 27, sex: 'female', allergies: ['Ibuprofen'] },
  { name: 'Abdul Qadir', phone: '+923990000115', age: 67, sex: 'male', conditions: ['Diabetes', 'Ischaemic heart disease'] },
  { name: 'Hira Javed', phone: '+923990000116', dob: '1998-07-09', sex: 'female', noKnownAllergies: true },
  { name: 'Shahid Mehmood', phone: '+923990000117', age: 44, sex: 'male', allergies: ['Penicillin'] },
  // No phone: an elderly patient brought in by someone who did not leave one.
  { name: 'Parveen Akhtar', age: 75, sex: 'female', conditions: ['Osteoarthritis', 'Hypertension'] },
  { name: 'Danish Iqbal', phone: '+923990000119', age: 19, sex: 'male', noKnownAllergies: true },
  {
    name: 'Saima Nawaz',
    phone: '+923990000120',
    age: 41,
    sex: 'female',
    conditions: ['Hypothyroidism'],
    noKnownAllergies: true,
  },
];

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

/**
 * The clinic this person may add patients to, named either by the clinic's own
 * name or by one of its locations - people tend to call a clinic by its branch.
 * Patients belong to the whole clinic, so a location only picks which one.
 */
const findClinic = async (phone: string, clinicName: string) => {
  const user = await User.findOne({ phone });
  if (!user) {
    throw new Error(`Nobody has signed in with ${phone} on this database.`);
  }

  const memberships = (await Membership.find({ userId: user._id, status: 'active' })).filter((membership) =>
    can(membership.role, 'patient.create'),
  );
  const clinics = await Practice.find({ _id: { $in: memberships.map((m) => m.practiceId) }, deletedAt: null });
  const locations = await Location.find({
    practiceId: { $in: clinics.map((clinic) => clinic._id) },
    status: 'active',
    deletedAt: null,
  });

  const wanted = clinicName.trim().toLowerCase();
  const named = (name: string) => name.trim().toLowerCase() === wanted;
  const matching = clinics.filter(
    (clinic) =>
      named(clinic.name) || locations.some((location) => location.practiceId.equals(clinic._id) && named(location.name)),
  );

  if (matching.length !== 1) {
    const names =
      clinics
        .map((clinic) => {
          const branches = locations.filter((location) => location.practiceId.equals(clinic._id)).map((l) => l.name);
          return `"${clinic.name}" (${branches.join(', ')})`;
        })
        .join(', ') || 'none';
    throw new Error(
      `${matching.length === 0 ? 'No' : 'More than one'} clinic or location called "${clinicName}" where ${phone} ` +
        `can add patients. Their clinics: ${names}.`,
    );
  }

  const clinic = matching[0];
  const membership = memberships.find((m) => m.practiceId.equals(clinic._id))!;
  const location = locations.find((l) => l.practiceId.equals(clinic._id) && named(l.name)) ?? null;
  return { user, clinic, membership, location };
};

const run = async (): Promise<void> => {
  const phone = argument('phone')?.replace(/[\s-]/g, '');
  const clinicName = argument('clinic');
  const count = Number(argument('count') ?? SAMPLES.length);
  const today = process.argv.includes('--today');
  if (!phone || !clinicName || !Number.isInteger(count) || count < 1 || count > SAMPLES.length) {
    throw new Error(`Usage: --phone +923001234567 --clinic "Clinic name" [--count 1-${SAMPLES.length}] [--today]`);
  }

  await mongoose.connect(config.mongoose.url);
  logger.info(`Connected to database "${mongoose.connection.name}" on ${mongoose.connection.host}`);

  const { user, clinic, membership, location } = await findClinic(phone, clinicName);
  const scope: Scope = {
    practiceId: clinic._id,
    actorId: user._id,
    role: membership.role,
    allowedLocationIds: membership.role === 'doctor' ? 'all' : membership.locationIds,
  };

  if (today && !location) {
    throw new Error(`--today needs --clinic to name a location, so it knows whose list to put them on.`);
  }
  if (
    today &&
    location &&
    scope.allowedLocationIds !== 'all' &&
    !scope.allowedLocationIds.some((id) => id.equals(location._id))
  ) {
    throw new Error(
      `${user.name || phone} does not work at ${location.name}. ` +
        `Use the phone of the doctor or of an assistant assigned there.`,
    );
  }
  const listScope: Scope = { ...scope, locationId: location?._id };

  const lines: string[] = [];
  let added = 0;
  // One at a time, so the MR numbers and the tokens run in the order of the list above.
  for (let i = 0; i < count; i += 1) {
    const sample = SAMPLES[i];
    // eslint-disable-next-line no-await-in-loop
    const existing = await Patient.findOne({
      practiceId: clinic._id,
      name: sample.name,
      phone: sample.phone ?? '',
      deletedAt: null,
    }).select('_id mrNo name');

    let patient = existing ? { id: String(existing._id), mrNo: existing.mrNo, name: existing.name } : null;
    if (!patient) {
      // eslint-disable-next-line no-await-in-loop
      patient = await createPatient(scope, createPatientBodySchema.parse(sample));
      added += 1;
    }

    let line = `${patient.mrNo} ${patient.name}`;
    if (today) {
      // eslint-disable-next-line no-await-in-loop
      const visit = await createVisit(listScope, createVisitBodySchema.parse({ patientId: patient.id }));
      line += ` - token ${visit.token}, ${visit.status}`;
    }
    lines.push(line);
  }

  logger.info(`Added ${added} patient(s) to "${clinic.name}" as ${user.name || phone}; ${count - added} already there`);
  if (today && location) {
    logger.info(`On today's list at ${location.name}:`);
  }
  lines.forEach((line) => logger.info(`  ${line}`));
};

run()
  .catch((error: Error) => {
    logger.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
