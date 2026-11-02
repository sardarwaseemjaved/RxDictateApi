import { randomBytes } from 'crypto';
import config from '../config/config';
import { AppError } from '../core/errors';
import { Patient, Prescription, type PrescriptionDoc } from '../models';
import { verifyViewSchema, type VerifyView } from '../shared/verify.schema';
import { qrSvg } from '../utils/qr';
import { ageFromDob } from '../utils/time';
import { wireSections } from './prescriptionOps.service';

/**
 * Checking a printout against what the doctor approved, from the QR code on
 * it. Public and permanent: no sign-in and no expiry, because the paper is
 * kept for months and whoever scans it has no account here.
 *
 * Anyone holding the paper can scan it, so the answer is what a pharmacist
 * needs to compare against the page - the Rx ID, the doctor, the clinic, the
 * medicines - and a patient line that matches the paper to the person without
 * identifying them. Never a name, a phone, an MR number, or the diagnosis,
 * complaints, history, examination, labs, diet or advice.
 *
 * A read writes no audit row: there is nobody to attribute it to, and a row per
 * scan would let anyone fill the audit log from a phone.
 */

/** 16 random bytes in base64url: 22 characters. */
const CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * A new code, made at approval. Random rather than derived from the id or the
 * Rx number, both of which can be guessed; the unique index on the field is
 * what holds if two ever met.
 */
export const newVerificationCode = (): string => randomBytes(16).toString('base64url');

/** The link a printout's QR code holds. */
export const verificationUrl = (code: string): string => `${config.verify.baseUrl}/${code}`;

/** What a PrescriptionView carries: set from approval on, null before. */
export const verificationOf = (prescription: PrescriptionDoc): { code: string; url: string } | null =>
  prescription.verificationCode
    ? { code: prescription.verificationCode, url: verificationUrl(prescription.verificationCode) }
    : null;

/**
 * One answer for every miss - malformed, unknown, a draft, a cancelled one -
 * so nothing about the response says which kind of miss it was.
 */
const noSuchCode = (): AppError => new AppError('NOT_FOUND', 'No prescription matches this code.');

const findByCode = async (code: string): Promise<PrescriptionDoc> => {
  if (!CODE_PATTERN.test(code)) {
    throw noSuchCode();
  }
  const prescription = await Prescription.findOne({
    verificationCode: code,
    status: { $in: ['approved', 'superseded'] },
    deletedAt: null,
  });
  if (!prescription?.number || !prescription.approvedAt) {
    throw noSuchCode();
  }
  return prescription;
};

/** "Muhammad Ali Khan" is "M. K.": the first letters of the first and last words. */
export const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return picked.map((word) => `${Array.from(word)[0].toLocaleUpperCase('en')}.`).join(' ');
};

/** Revisions in a row are a handful at most; a chain longer than this is broken data, not a history. */
const MAX_REVISIONS = 50;

/**
 * The approved version that stands in this one's place now: the newest, through
 * any revisions approved in between, because that is the page the patient
 * should be holding. Null if the chain is broken.
 */
const replacementOf = async (superseded: PrescriptionDoc): Promise<PrescriptionDoc | null> => {
  let current = superseded;
  for (let hop = 0; hop < MAX_REVISIONS; hop += 1) {
    // eslint-disable-next-line no-await-in-loop
    const next = await Prescription.findOne({
      practiceId: superseded.practiceId,
      previousVersionId: current._id,
      status: { $in: ['approved', 'superseded'] },
      deletedAt: null,
    });
    if (!next) {
      return current === superseded ? null : current;
    }
    if (next.status === 'approved') {
      return next;
    }
    current = next;
  }
  return null;
};

/**
 * GET /verify/:code.
 *
 * A superseded prescription answers `replaced`, with the version that took its
 * place and no medicines: the old list is no longer valid, and showing it would
 * help nobody but whoever is passing the old page off. Version 1 is only
 * superseded once version 2 is approved, so while a revision is still a draft
 * the paper in the patient's hand answers `valid`.
 *
 * The age is the one the printout showed: from the date of birth as of the day
 * it was approved, or the age that was typed in.
 */
export const getVerification = async (code: string): Promise<VerifyView> => {
  const prescription = await findByCode(code);

  // Patients are only ever soft-deleted, so this finds them; a prescription that
  // cannot be matched to anybody is not one this page can vouch for.
  const patient = await Patient.findOne({ _id: prescription.patientId, practiceId: prescription.practiceId });
  if (!patient) {
    throw noSuchCode();
  }

  const replaced = prescription.status === 'superseded';
  const replacement = replaced ? await replacementOf(prescription) : null;
  const snapshot = prescription.letterheadSnapshot;

  return verifyViewSchema.parse({
    status: replaced ? 'replaced' : 'valid',
    number: prescription.number,
    approvedAt: prescription.approvedAt,
    doctor: {
      name: snapshot?.doctorName ?? '',
      qualifications: [...(snapshot?.qualifications ?? [])],
      speciality: snapshot?.speciality ?? '',
      pmdcNo: snapshot?.pmdcNo ?? '',
    },
    clinic: { name: snapshot?.locationName ?? '', address: snapshot?.address ?? '' },
    patient: {
      initials: initialsOf(patient.name),
      age: patient.dob ? ageFromDob(patient.dob, prescription.approvedAt ?? undefined) : patient.age,
      sex: patient.sex,
    },
    // Parsing through the contract keeps only the picked fields of each line.
    medicines: replaced ? [] : wireSections(prescription.sections).medicines,
    replacedBy:
      replacement?.number && replacement.approvedAt
        ? { number: replacement.number, approvedAt: replacement.approvedAt }
        : null,
  });
};

/** GET /verify/:code/qr.svg: the QR of the link, for any code the page itself would answer. */
export const verificationQr = async (code: string): Promise<string> => {
  const prescription = await findByCode(code);
  return qrSvg(verificationUrl(prescription.verificationCode ?? code));
};

/**
 * Give every approved or superseded prescription from before codes existed its
 * own, so every page already printed - without a QR - can be checked once it
 * is reprinted. Runs at boot, after the indexes. Each row gets its own random
 * code, so it is one update per row rather than one for all; only rows still
 * without a code are written, so a second run does nothing.
 */
export const backfillVerificationCodes = async (): Promise<number> => {
  const missing = await Prescription.find({
    status: { $in: ['approved', 'superseded'] },
    verificationCode: null,
  }).select('_id');
  if (missing.length === 0) {
    return 0;
  }

  const result = await Prescription.bulkWrite(
    missing.map(({ _id }) => ({
      updateOne: {
        filter: { _id, verificationCode: null },
        update: { $set: { verificationCode: newVerificationCode() } },
      },
    })),
  );
  return result.modifiedCount;
};

export default {
  newVerificationCode,
  verificationUrl,
  verificationOf,
  initialsOf,
  getVerification,
  verificationQr,
  backfillVerificationCodes,
};
