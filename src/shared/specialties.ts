import { z } from 'zod';

/**
 * What a doctor practises, picked from a list so it can be matched on: an
 * announcement for paediatricians reaches exactly the doctors who said so.
 *
 * It belongs to the person, so it lives on the user and follows them from one
 * clinic to the next. The letterhead's free-text speciality line
 * ("Consultant Physician") is a different thing, printed as typed, and stays.
 *
 * The values are keys, never shown: SPECIALTY_LABELS is what a screen says.
 */
export const SPECIALTIES = [
  'generalPractice',
  'internalMedicine',
  'paediatrics',
  'gynaecologyObstetrics',
  'cardiology',
  'dermatology',
  'ent',
  'ophthalmology',
  'orthopaedics',
  'psychiatry',
  'neurology',
  'gastroenterology',
  'pulmonology',
  'nephrology',
  'urology',
  'endocrinology',
  'generalSurgery',
  'dentistry',
  'other',
] as const;

export const specialtySchema = z.enum(SPECIALTIES);
export type Specialty = z.infer<typeof specialtySchema>;

export const SPECIALTY_LABELS: Record<Specialty, string> = {
  generalPractice: 'General practice',
  internalMedicine: 'Internal medicine',
  paediatrics: 'Paediatrics',
  gynaecologyObstetrics: 'Gynaecology and obstetrics',
  cardiology: 'Cardiology',
  dermatology: 'Dermatology',
  ent: 'ENT',
  ophthalmology: 'Ophthalmology',
  orthopaedics: 'Orthopaedics',
  psychiatry: 'Psychiatry',
  neurology: 'Neurology',
  gastroenterology: 'Gastroenterology',
  pulmonology: 'Pulmonology',
  nephrology: 'Nephrology',
  urology: 'Urology',
  endocrinology: 'Endocrinology',
  generalSurgery: 'General surgery',
  dentistry: 'Dentistry',
  other: 'Other',
};

/** A doctor's list: each one at most once, in the order they were picked. */
export const specialtiesSchema = z
  .array(specialtySchema)
  .max(SPECIALTIES.length)
  .transform((picked) => [...new Set(picked)]);
