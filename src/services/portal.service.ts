import { randomBytes } from 'crypto';
import { Types } from 'mongoose';
import {
  Appointment,
  LIVE_LINK_STATUSES,
  Location,
  Patient,
  PatientInvite,
  PatientLink,
  Practice,
  Prescription,
  Report,
  Visit,
  Vital,
  type PatientDoc,
  type PatientInviteDoc,
  type PatientLinkDoc,
  type PracticeDoc,
  type PrescriptionDoc,
  type ReportDoc,
} from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import { portalReportPrefix, reportExtensionFor, signedGetUrl, signedPutUrl } from '../core/storage';
import {
  portalFileLinkSchema,
  portalLinkViewSchema,
  portalPrescriptionListItemSchema,
  portalPrescriptionViewSchema,
  portalReportDetailViewSchema,
  portalReportViewSchema,
  portalVitalsViewSchema,
  type PortalAppointmentView,
  type PortalCreateReportBody,
  type PortalFileLink,
  type PortalFollowUpView,
  type PortalLinkBody,
  type PortalLinkPreview,
  type PortalLinkView,
  type PortalListAppointmentsQuery,
  type PortalPatient,
  type PortalPrescriptionListItem,
  type PortalPrescriptionView,
  type PortalReportDetailView,
  type PortalReportView,
  type PortalVitalsView,
} from '../shared/portal.schema';
import { letterheadSnapshotSchema } from '../shared/prescription.schema';
import type { CreateUploadBody, UploadTicket } from '../shared/report.schema';
import type { PageMeta, PaginationQuery } from '../shared';
import { addDays, ageFromDob, karachiDay, todayInKarachi } from '../utils/time';
import { hasLapsed, patientScope, portalIsOn, settleLapsedLink } from './patientLink.service';
import { inviteCodeHash } from './patientPortal.service';
import { printFileOf } from './prescription.service';
import { wireSections } from './prescriptionOps.service';
import { fileReport } from './report.service';
import { CODE_PATTERN, replacementOf, verificationOf } from './verify.service';

/**
 * The patient's own area. A patient is not a member of a clinic, so nothing here
 * goes through the clinic's repositories or tenancy: linking starts from a code,
 * and every record route starts from the link resolvePortalLink has already
 * checked, reading only that link's own patient.
 */

/** Who is asking: what requireAuth proved. */
export interface PortalUser {
  userId: Types.ObjectId;
  phone: string;
}

/** What resolvePortalLink hands every record route. */
export interface PortalRecord {
  link: PatientLinkDoc;
  patient: PatientDoc;
}

const pageMeta = (result: { page: number; limit: number; totalResults: number; totalPages: number }): PageMeta => ({
  page: result.page,
  limit: result.limit,
  total: result.totalResults,
  totalPages: result.totalPages,
});

const toPortalPatient = (patient: PatientDoc): PortalPatient => ({
  name: patient.name,
  age: patient.dob ? ageFromDob(patient.dob) : patient.age,
  sex: patient.sex,
});

const announce = (link: PatientLinkDoc): void => {
  emit('patient.updated', { practiceId: link.practiceId, patientId: link.patientId, actorId: link.userId });
};

/* ------------------------------------------------------------------ *
 * Linking
 * ------------------------------------------------------------------ */

/**
 * One answer for every reason, so nothing here says whether a record exists:
 * a wrong code, a wrong phone, the portal off, a blocked record, one linked to
 * somebody else.
 */
const couldNotLink = (): AppError =>
  new AppError('PORTAL_LINK_FAILED', "We couldn't link this record. Check the code, or ask your clinic.");

interface Linkable {
  patient: PatientDoc;
  practice: PracticeDoc;
  /** Set when an invite's code was tried, whether or not it can still be used. */
  invite: PatientInviteDoc | null;
  /** This person's own link to the record, if they still hold one. */
  own: PatientLinkDoc | null;
}

/** The record a code points at. Only an approved or superseded prescription has a code that counts. */
const recordOfCode = async (
  body: PortalLinkBody,
): Promise<{ practiceId: Types.ObjectId; patientId: Types.ObjectId; invite: PatientInviteDoc | null } | null> => {
  if (!CODE_PATTERN.test(body.code)) {
    return null;
  }
  if (body.kind === 'invite') {
    const invite = await PatientInvite.findOne({ codeHash: inviteCodeHash(body.code) });
    return invite ? { practiceId: invite.practiceId, patientId: invite.patientId, invite } : null;
  }
  const prescription = await Prescription.findOne({
    verificationCode: body.code,
    status: { $in: ['approved', 'superseded'] },
    deletedAt: null,
  }).select('practiceId patientId');
  return prescription ? { practiceId: prescription.practiceId, patientId: prescription.patientId, invite: null } : null;
};

const inviteStillWorks = (invite: PatientInviteDoc): boolean =>
  invite.usedAt === null && invite.expiresAt !== null && invite.expiresAt > new Date();

/** Everything linking needs to be true, changing nothing. A phone match alone never gets this far. */
const linkableFrom = async (user: PortalUser, body: PortalLinkBody): Promise<Linkable> => {
  const found = await recordOfCode(body);
  if (!found) {
    throw couldNotLink();
  }
  const { practiceId, patientId, invite } = found;

  const [patient, practice, enabled, links] = await Promise.all([
    Patient.findOne({ _id: patientId, practiceId, deletedAt: null }),
    Practice.findOne({ _id: practiceId, type: 'clinic', deletedAt: null }),
    portalIsOn(practiceId),
    PatientLink.find({ practiceId, patientId, status: { $in: LIVE_LINK_STATUSES } }),
  ]);

  if (!patient || !practice || !enabled || patient.portalBlocked || !patient.phone || patient.phone !== user.phone) {
    throw couldNotLink();
  }

  const own = links.find((link) => link.userId.equals(user.userId)) ?? null;
  if (links.some((link) => link.status === 'active' && !link.userId.equals(user.userId))) {
    throw couldNotLink();
  }

  // A used invite works only as a retry by whoever still holds a good link: it
  // links nothing new, and an answer lost on a bad network doesn't become an error.
  if (invite && !inviteStillWorks(invite)) {
    const retry = invite.usedAt !== null && own !== null && own.status === 'active' && !hasLapsed(own);
    if (!retry) {
      throw couldNotLink();
    }
  }

  return { patient, practice, invite, own };
};

export const previewLink = async (user: PortalUser, body: PortalLinkBody): Promise<PortalLinkPreview> => {
  const { patient, practice } = await linkableFrom(user, body);
  return { clinic: { name: practice.name }, patient: toPortalPatient(patient) };
};

const toLinkView = (link: PatientLinkDoc, patient: PatientDoc, practice: PracticeDoc, enabled: boolean): PortalLinkView => {
  let status: PortalLinkView['status'] = link.status === 'dormant' ? 'dormant' : 'active';
  if (!enabled || patient.portalBlocked) {
    status = 'unavailable';
  }
  return portalLinkViewSchema.parse({
    id: String(link._id),
    status,
    linkedAt: link.linkedAt,
    clinic: { name: practice.name },
    patient: toPortalPatient(patient),
  });
};

/**
 * Make the link, revive a dormant one, or, for a link that's fine as it is,
 * just say so. `created` is whether a new one was made.
 */
export const createLink = async (
  user: PortalUser,
  body: PortalLinkBody,
): Promise<{ link: PortalLinkView; created: boolean }> => {
  const { patient, practice, invite, own } = await linkableFrom(user, body);
  const now = new Date();

  // Consumed first, and atomically, so one code can't be used twice at once.
  if (invite && inviteStillWorks(invite)) {
    const consumed = await PatientInvite.findOneAndUpdate(
      { _id: invite._id, codeHash: invite.codeHash, usedAt: null },
      { $set: { usedAt: now } },
    );
    if (!consumed) {
      throw couldNotLink();
    }
  }

  if (own && own.status === 'active' && !hasLapsed(own, now)) {
    return { link: toLinkView(own, patient, practice, true), created: false };
  }

  const scope = patientScope(patient.practiceId, user.userId);
  let link: PatientLinkDoc;
  try {
    if (own) {
      own.status = 'active';
      own.lastUsedAt = now;
      own.madeBy = body.kind;
      link = await own.save();
    } else {
      link = await PatientLink.create({
        userId: user.userId,
        patientId: patient._id,
        practiceId: patient.practiceId,
        madeBy: body.kind,
        linkedAt: now,
        lastUsedAt: now,
        status: 'active',
      });
    }
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      // The index decided between two requests. If it was this person's other
      // tap that won, that's the link they asked for.
      const winner = await PatientLink.findOne({ userId: user.userId, patientId: patient._id, status: 'active' });
      if (winner) {
        return { link: toLinkView(winner, patient, practice, true), created: false };
      }
      throw couldNotLink();
    }
    throw error;
  }

  await writeAudit(scope, {
    action: own ? 'patient.portal.revive' : 'patient.portal.link',
    entity: 'patientLink',
    entityId: link._id,
    after: { status: 'active', madeBy: body.kind },
  });
  announce(link);

  return { link: toLinkView(link, patient, practice, true), created: !own };
};

/** This person's links, with each one's state as of now. Removed ones aren't theirs any more. */
export const listLinks = async (user: PortalUser): Promise<PortalLinkView[]> => {
  const links = await PatientLink.find({ userId: user.userId, status: { $in: LIVE_LINK_STATUSES } }).sort({ linkedAt: -1 });
  await Promise.all(links.map(settleLapsedLink));

  const [patients, practices] = await Promise.all([
    Patient.find({ _id: { $in: links.map((link) => link.patientId) }, deletedAt: null }),
    Practice.find({ _id: { $in: links.map((link) => link.practiceId) }, deletedAt: null }),
  ]);
  const patientsById = new Map(patients.map((patient) => [String(patient._id), patient]));
  const practicesById = new Map(practices.map((practice) => [String(practice._id), practice]));
  const enabled = new Map(
    await Promise.all(practices.map(async (practice) => [String(practice._id), await portalIsOn(practice._id)] as const)),
  );

  return links.flatMap((link) => {
    const patient = patientsById.get(String(link.patientId));
    const practice = practicesById.get(String(link.practiceId));
    return patient && practice ? [toLinkView(link, patient, practice, enabled.get(String(practice._id)) ?? false)] : [];
  });
};

/** How many records this person holds, for /me. */
export const countLinks = async (userId: Types.ObjectId): Promise<number> =>
  PatientLink.countDocuments({ userId, status: { $in: LIVE_LINK_STATUSES } });

/** The patient takes their own link away. Works on a dormant or unavailable one too. */
export const removeOwnLink = async (user: PortalUser, linkId: string): Promise<{ removed: true }> => {
  const link = await PatientLink.findOneAndUpdate(
    { _id: linkId, userId: user.userId, status: { $in: LIVE_LINK_STATUSES } },
    { $set: { status: 'removed', removedBy: user.userId, removedAt: new Date(), removedReason: 'patient' } },
  );
  if (!link) {
    throw AppError.notFound('Link');
  }

  await writeAudit(patientScope(link.practiceId, user.userId), {
    action: 'patient.portal.unlink',
    entity: 'patientLink',
    entityId: link._id,
    before: { status: link.status },
    after: { status: 'removed', reason: 'patient' },
  });
  announce(link);

  return { removed: true };
};

/* ------------------------------------------------------------------ *
 * Records: only what the clinic has finished
 * ------------------------------------------------------------------ */

const ofRecord = ({ link }: PortalRecord) => ({ practiceId: link.practiceId, patientId: link.patientId, deletedAt: null });

const FINISHED = ['approved', 'superseded'];

/** Signed, and so numbered. A draft or a cancelled one doesn't match. */
const finishedPrescriptions = (record: PortalRecord) => ({
  ...ofRecord(record),
  status: { $in: FINISHED },
  number: { $type: 'string' },
  approvedAt: { $ne: null },
  verificationCode: { $type: 'string' },
});

const listItemOf = async (prescription: PrescriptionDoc): Promise<PortalPrescriptionListItem> => {
  const replacement = prescription.status === 'superseded' ? await replacementOf(prescription) : null;
  return portalPrescriptionListItemSchema.parse({
    id: String(prescription._id),
    number: prescription.number,
    version: prescription.version,
    status: prescription.status,
    approvedAt: prescription.approvedAt,
    doctorName: prescription.letterheadSnapshot?.doctorName ?? '',
    locationName: prescription.letterheadSnapshot?.locationName ?? '',
    replacedBy:
      replacement?.number && replacement.approvedAt
        ? { id: String(replacement._id), number: replacement.number, approvedAt: replacement.approvedAt }
        : null,
  });
};

export const listPrescriptions = async (
  record: PortalRecord,
  query: PaginationQuery,
): Promise<{ prescriptions: PortalPrescriptionListItem[]; meta: PageMeta }> => {
  const result = await Prescription.paginate(finishedPrescriptions(record), {
    page: query.page,
    limit: query.limit,
    sortBy: 'approvedAt:desc',
  });
  return { prescriptions: await Promise.all(result.results.map(listItemOf)), meta: pageMeta(result) };
};

const findFinishedPrescription = async (record: PortalRecord, id: string): Promise<PrescriptionDoc> => {
  const prescription = await Prescription.findOne({ _id: id, ...finishedPrescriptions(record) });
  if (!prescription) {
    throw AppError.notFound('Prescription');
  }
  return prescription;
};

/** As printed: the frozen letterhead, and the age the page showed the day it was signed. */
export const getPrescription = async (record: PortalRecord, id: string): Promise<PortalPrescriptionView> => {
  const prescription = await findFinishedPrescription(record, id);
  const { patient } = record;
  const sections = wireSections(prescription.sections);

  // Parsing through the view keeps only what it names: no ids, flags or spans on a line.
  return portalPrescriptionViewSchema.parse({
    ...(await listItemOf(prescription)),
    printLanguage: prescription.printLanguage,
    patient: {
      name: patient.name,
      age: patient.dob ? ageFromDob(patient.dob, prescription.approvedAt ?? undefined) : patient.age,
      sex: patient.sex,
    },
    letterhead: letterheadSnapshotSchema.parse(prescription.letterheadSnapshot ?? {}),
    sections,
    verification: verificationOf(prescription),
  });
};

export const prescriptionPdf = async (record: PortalRecord, id: string): Promise<PortalFileLink> => {
  const prescription = await findFinishedPrescription(record, id);
  const file = await printFileOf(prescription);

  await writeAudit(patientScope(record.link.practiceId, record.link.userId), {
    action: 'prescription.print',
    entity: 'prescription',
    entityId: prescription._id,
    after: { number: prescription.number },
  });

  return portalFileLinkSchema.parse(file);
};

const toReportView = (report: ReportDoc): PortalReportView =>
  portalReportViewSchema.parse({
    id: String(report._id),
    type: report.type,
    testName: report.testName,
    testDate: report.testDate,
    pages: report.pageKeys.length,
    source: report.source,
    reviewed: report.reviewedAt !== null,
    createdAt: report.createdAt,
  });

export const listReports = async (
  record: PortalRecord,
  query: PaginationQuery,
): Promise<{ reports: PortalReportView[]; meta: PageMeta }> => {
  const result = await Report.paginate(ofRecord(record), {
    page: query.page,
    limit: query.limit,
    sortBy: 'testDate:desc',
  });
  return { reports: result.results.map(toReportView), meta: pageMeta(result) };
};

export const getReport = async (record: PortalRecord, id: string): Promise<PortalReportDetailView> => {
  const report = await Report.findOne({ _id: id, ...ofRecord(record) });
  if (!report) {
    throw AppError.notFound('Report');
  }
  const pageUrls = await Promise.all(report.pageKeys.map((key) => signedGetUrl(key)));
  return portalReportDetailViewSchema.parse({ ...toReportView(report), pageUrls });
};

export const listAppointments = async (
  record: PortalRecord,
  query: PortalListAppointmentsQuery,
): Promise<{ appointments: PortalAppointmentView[]; meta: PageMeta }> => {
  const now = new Date();
  const result = await Appointment.paginate(
    {
      ...ofRecord(record),
      ...(query.includeCancelled ? {} : { status: { $ne: 'cancelled' } }),
      ...(query.when === 'upcoming' ? { at: { $gte: now } } : {}),
      ...(query.when === 'past' ? { at: { $lt: now } } : {}),
    },
    { page: query.page, limit: query.limit, sortBy: query.when === 'upcoming' ? 'at:asc' : 'at:desc' },
  );

  const locations = await Location.find({ _id: { $in: result.results.map((row) => row.locationId) } }).select('name');
  const names = new Map(locations.map((location) => [String(location._id), location.name]));

  return {
    appointments: result.results.map((appointment) => ({
      id: String(appointment._id),
      at: appointment.at,
      kind: appointment.kind,
      status: appointment.status,
      locationName: names.get(String(appointment.locationId)) ?? '',
    })),
    meta: pageMeta(result),
  };
};

/**
 * Worked out from the prescriptions, like the assistant's list and for the same
 * reason. Unlike that list, a follow-up the doctor didn't ask the assistant to
 * book counts: the patient was still told to come back.
 */
export const listFollowUps = async (
  record: PortalRecord,
  query: PaginationQuery,
): Promise<{ followUps: PortalFollowUpView[]; meta: PageMeta }> => {
  const asked = await Prescription.find({
    ...ofRecord(record),
    status: 'approved',
    $or: [{ 'sections.followUp.date': { $ne: null } }, { 'sections.followUp.inDays': { $ne: null } }],
  }).select('sections.followUp approvedAt');

  const booked = await Appointment.find({
    ...ofRecord(record),
    status: { $in: ['booked', 'arrived'] },
    prescriptionId: { $in: asked.map((prescription) => prescription._id) },
  }).select('prescriptionId');
  const bookedFor = new Set(booked.map((appointment) => String(appointment.prescriptionId)));

  const today = todayInKarachi();
  const { lastVisitDate } = record.patient;

  const all = asked
    .flatMap((prescription) => {
      const { followUp } = prescription.sections;
      const dueDate =
        followUp.date ??
        (followUp.inDays !== null && prescription.approvedAt
          ? karachiDay(addDays(prescription.approvedAt, followUp.inDays))
          : null);
      if (!dueDate) {
        return [];
      }
      const isBooked = bookedFor.has(String(prescription._id));
      const cameSince = lastVisitDate !== null && lastVisitDate >= dueDate;
      return [
        {
          prescriptionId: String(prescription._id),
          dueDate,
          note: followUp.note,
          booked: isBooked,
          isOverdue: dueDate < today && !isBooked && !cameSince,
        },
      ];
    })
    .sort((a, b) => b.dueDate.localeCompare(a.dueDate));

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

/** Readings from finished visits only: while the patient is still on the day's list, they aren't final. */
export const listVitals = async (
  record: PortalRecord,
  query: PaginationQuery,
): Promise<{ vitals: PortalVitalsView[]; meta: PageMeta }> => {
  const visitIds = await Visit.distinct('_id', { ...ofRecord(record), status: 'done' });
  const filter = { practiceId: record.link.practiceId, visitId: { $in: visitIds }, deletedAt: null };

  const [rows, total] = await Promise.all([
    Vital.find(filter)
      .sort({ recordedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    Vital.countDocuments(filter),
  ]);

  return {
    vitals: rows.map((row) =>
      portalVitalsViewSchema.parse({
        id: String(row._id),
        recordedAt: row.recordedAt,
        bp: row.bp,
        pulse: row.pulse,
        tempF: row.tempF,
        weightKg: row.weightKg,
        spo2: row.spo2,
        bloodSugarRandom: row.bloodSugarRandom,
      }),
    ),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) },
  };
};

/* ------------------------------------------------------------------ *
 * Uploading a report
 * ------------------------------------------------------------------ */

const PAGE_NAME = /^[0-9a-f]{24}\.(jpg|png|pdf)$/;

/** Step one: somewhere to PUT one page, under this link and no other. */
export const createUpload = async ({ link }: PortalRecord, body: CreateUploadBody): Promise<UploadTicket> => {
  const name = `${randomBytes(12).toString('hex')}.${reportExtensionFor(body.contentType)}`;
  const key = `${portalReportPrefix(link.practiceId, link._id)}${name}`;
  const signed = await signedPutUrl(key, body.contentType, { size: body.size });

  return { uploadUrl: signed.url, fileKey: key, expiresAt: signed.expiresAt };
};

/**
 * Step two. The whole shape of each key is checked, not just its start: a key
 * with `..` in it would otherwise pass as this link's and read somebody else's
 * file back through the signed link.
 */
export const createReport = async (
  { link, patient }: PortalRecord,
  body: PortalCreateReportBody,
): Promise<PortalReportView> => {
  const prefix = portalReportPrefix(link.practiceId, link._id);
  const foreign = body.pageKeys.find((key) => !key.startsWith(prefix) || !PAGE_NAME.test(key.slice(prefix.length)));
  if (foreign) {
    throw new AppError('VALIDATION_ERROR', 'One of those page keys was not issued for this record.');
  }

  const report = await fileReport(patientScope(link.practiceId, link.userId), patient._id, {
    visitId: null,
    type: body.type,
    testName: body.testName,
    testDate: body.testDate,
    pageKeys: body.pageKeys,
    source: 'patient',
  });
  return toReportView(report);
};

export default {
  previewLink,
  createLink,
  listLinks,
  countLinks,
  removeOwnLink,
  listPrescriptions,
  getPrescription,
  prescriptionPdf,
  listReports,
  getReport,
  listAppointments,
  listFollowUps,
  listVitals,
  createUpload,
  createReport,
};
