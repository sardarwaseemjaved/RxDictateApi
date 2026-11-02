import { Types } from 'mongoose';
import logger from '../config/logger';
import {
  Lab,
  Location,
  Patient,
  Practice,
  Prescription,
  User,
  Visit,
  Vital,
  VoiceSession,
  type IPatient,
  type IPrescription,
  type PatientDoc,
  type PrescriptionDoc,
  type VisitDoc,
} from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import { signedGetUrl } from '../core/storage';
import type {
  CreateFromTemplateBody,
  CreatePrescriptionBody,
  LetterheadSnapshot,
  ListPrescriptionsQuery,
  Op,
  PatchPrescriptionBody,
  PrescriptionListItem,
  PrescriptionSections,
  PrescriptionSource,
  PrescriptionView,
  PrintLanguage,
  RevisePrescriptionBody,
} from '../shared/prescription.schema';
import { LIST_SECTIONS, prescriptionSectionsSchema, prescriptionViewSchema } from '../shared/prescription.schema';
import type { PageMeta, SignedUrlView } from '../shared';
import { addDays, ageFromDob, karachiDayRange } from '../utils/time';
import { applyOps, isEmpty, wireSections } from './prescriptionOps.service';
import { nextPrescriptionNumber } from './counter.service';
import { findOrCreateDrug } from './drug.service';
import { findPatientOrFail, linkPatient, patientMatch, toPatientSummary, visiblePatients } from './patient.service';
import { renderPrescription, renderPreview } from './pdf.service';
import { findOwnTemplate, markTemplateUsed } from './template.service';
import { newVerificationCode, verificationOf } from './verify.service';
import { changeVisitStatus, ensureVisit } from './visit.service';

const prescriptions = new BaseRepository<IPrescription>(Prescription, { locationScoped: true });
const patients = new BaseRepository<IPatient>(Patient);

/**
 * The shape the app reads, parsed through the contract rather than assembled
 * to look like it.
 *
 * Going through the schema is what stops the two drifting: a field added to
 * the contract and not filled in here is a type error, and anything returned
 * that the contract does not declare - a mongoose internal, the practice id -
 * is stripped before it leaves.
 */
export const toPrescriptionView = (
  prescription: PrescriptionDoc,
  /** Looked up by the caller, which can do it once for a whole page. */
  revisionId: Types.ObjectId | null = null,
): PrescriptionView =>
  prescriptionViewSchema.parse({
    id: String(prescription._id),
    locationId: String(prescription.locationId),
    patientId: String(prescription.patientId),
    visitId: prescription.visitId ? String(prescription.visitId) : null,
    doctorId: String(prescription.doctorId),
    number: prescription.number,
    version: prescription.version,
    previousVersionId: prescription.previousVersionId ? String(prescription.previousVersionId) : null,
    revisionId: revisionId ? String(revisionId) : null,
    status: prescription.status,
    source: prescription.source,
    sections: wireSections(prescription.sections),
    printLanguage: prescription.printLanguage,
    letterheadSnapshot: prescription.letterheadSnapshot,
    approvedAt: prescription.approvedAt,
    approvedBy: prescription.approvedBy ? String(prescription.approvedBy) : null,
    hasPdf: prescription.pdfKey !== null,
    verification: verificationOf(prescription),
    editCount: prescription.editLog.length,
    createdAt: prescription.createdAt,
    updatedAt: prescription.updatedAt,
  });

/**
 * Which of these prescriptions have an open revision.
 *
 * One query for a whole page rather than one per row, and derived from the
 * drafts themselves rather than stored on the prescription: a second field
 * pointing back would be a second thing that can disagree with
 * previousVersionId.
 */
const openRevisions = async (scope: Scope, ids: Types.ObjectId[]): Promise<Map<string, Types.ObjectId>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const drafts = await Prescription.find({
    practiceId: scope.practiceId,
    previousVersionId: { $in: ids },
    status: 'draft',
    deletedAt: null,
  }).select('previousVersionId');

  return new Map(drafts.map((draft) => [String(draft.previousVersionId), draft._id]));
};

/**
 * Only a draft can change.
 *
 * An approved prescription is a document a patient is holding, so it is
 * immutable: the way to change it is to revise it, which makes version 2 and
 * leaves version 1 on the record as superseded.
 */
const assertDraft = (prescription: PrescriptionDoc): void => {
  if (prescription.status === 'approved') {
    throw new AppError('RX_LOCKED', 'This prescription is approved. Revise it to make a new version.');
  }
  if (prescription.status !== 'draft') {
    throw new AppError('RX_NOT_DRAFT', `A ${prescription.status} prescription cannot be edited.`);
  }
};

export const getPrescriptionDoc = async (scope: Scope, id: string): Promise<PrescriptionDoc> =>
  prescriptions.findByIdOrFail(scope, id, 'Prescription');

/**
 * The patients a typed `q` names, matched as patient search matches them and
 * among the ones this member may see.
 *
 * Two indexed reads rather than one join: the patient indexes find the ids,
 * and (practiceId, patientId, createdAt) finds their prescriptions.
 */
const patientIdsMatching = async (scope: Scope, q: string): Promise<Types.ObjectId[]> => {
  const found = await Patient.find(patients.scopedFilter(scope, { ...patientMatch(q), ...visiblePatients(scope) })).select(
    '_id',
  );
  return found.map((patient) => patient._id);
};

/**
 * Every prescription at this location, newest first, each with who it is for.
 *
 * The patients are fetched once for the page rather than once per row, which
 * is the request the History page would otherwise have made itself.
 */
export const listPrescriptions = async (
  scope: Scope,
  query: ListPrescriptionsQuery,
): Promise<{ prescriptions: PrescriptionListItem[]; meta: PageMeta }> => {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;

  // Named by id, a patient this member may not see is NOT_FOUND here as it is
  // everywhere else.
  if (query.patientId) {
    await findPatientOrFail(scope, query.patientId);
  }

  if (query.q) {
    const named = await patientIdsMatching(scope, query.q);
    filter.patientId = {
      $in: query.patientId ? named.filter((id) => id.equals(query.patientId!)) : named,
    };
  } else if (query.patientId) {
    filter.patientId = new Types.ObjectId(query.patientId);
  }

  if (query.from || query.to) {
    filter.createdAt = {
      ...(query.from ? { $gte: karachiDayRange(query.from).start } : {}),
      ...(query.to ? { $lt: karachiDayRange(query.to).end } : {}),
    };
  }

  const result = await prescriptions.paginate(scope, filter, {
    page: query.page,
    limit: query.limit,
    sortBy: 'createdAt:desc',
  });

  const [revisions, named] = await Promise.all([
    openRevisions(
      scope,
      result.results.map((prescription) => prescription._id),
    ),
    patients.find(scope, { _id: { $in: result.results.map((prescription) => prescription.patientId) } }),
  ]);
  const patientsById = new Map(named.map((patient) => [String(patient._id), patient]));

  return {
    prescriptions: result.results.map((prescription) => {
      const patient = patientsById.get(String(prescription.patientId));
      return {
        ...toPrescriptionView(prescription, revisions.get(String(prescription._id)) ?? null),
        patient: patient ? toPatientSummary(patient) : null,
      };
    }),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

export const getPrescription = async (scope: Scope, id: string) => {
  const prescription = await getPrescriptionDoc(scope, id);
  const revisions = await openRevisions(scope, [prescription._id]);
  return toPrescriptionView(prescription, revisions.get(String(prescription._id)) ?? null);
};

/**
 * The patient, and the visit a prescription for them belongs to.
 *
 * With no visitId, the patient is put on today's list here. A doctor working
 * alone should not have to think about a queue: writing a prescription is what
 * says the consultation is happening, and the visit it needs is created or
 * found by that act.
 */
const patientAndVisit = async (
  scope: Scope,
  body: { patientId: string; visitId?: string | null },
): Promise<{ patient: PatientDoc; visit: VisitDoc }> => {
  const patient = await findPatientOrFail(scope, body.patientId);

  if (body.visitId) {
    const visit = await Visit.findOne({ _id: body.visitId, practiceId: scope.practiceId, deletedAt: null });
    if (!visit) {
      throw AppError.notFound('Visit');
    }
    // A prescription written here links the patient here, as the visit it
    // would otherwise have opened would have, so the assistant who prints it
    // can open the patient too.
    if (scope.locationId) {
      await linkPatient(scope.practiceId, patient._id, scope.locationId);
    }
    return { patient, visit };
  }

  // The find-or-create: a patient seen earlier today keeps the visit and the
  // token they already have.
  return { patient, visit: (await ensureVisit(scope, patient)).visit };
};

/**
 * The visit's open draft, or a new one.
 *
 * A visit has one draft at a time. A double tap, or the doctor opening the
 * same patient on a second device, must not produce two half-written
 * prescriptions for one consultation - so an existing draft for the visit
 * comes back untouched, the same way adding a patient to today's list twice
 * returns the visit they are already on. `created` says which happened.
 */
const openDraft = async (
  scope: Scope,
  patient: PatientDoc,
  visit: VisitDoc,
  init: { source: PrescriptionSource; printLanguage: PrintLanguage },
): Promise<{ draft: PrescriptionDoc; created: boolean }> => {
  const open = await prescriptions.findOne(scope, { visitId: visit._id, status: 'draft' });
  if (open) {
    return { draft: open, created: false };
  }

  let prescription: PrescriptionDoc;
  try {
    prescription = await prescriptions.create(scope, {
      patientId: patient._id,
      visitId: visit._id,
      doctorId: scope.actorId,
      status: 'draft',
      source: init.source,
      printLanguage: init.printLanguage,
      sections: prescriptionSectionsSchema.parse({}),
      version: 1,
    });
  } catch (error) {
    // The read above and this write are not one operation, so two devices can
    // both get past it. The unique index is what actually decides, and the
    // one that loses reads back the draft the winner made.
    if ((error as { code?: number }).code === 11000) {
      const winner = await prescriptions.findOne(scope, { visitId: visit._id, status: 'draft' });
      if (winner) {
        return { draft: winner, created: false };
      }
    }
    throw error;
  }

  /**
   * The assistant has usually already asked why the patient came and written
   * it down with the vitals. Starting the doctor with a blank complaints
   * section means typing it a second time.
   *
   * Applied through the ordinary op path, so it lands in the edit log like any
   * other change, and only ever at creation: an existing draft above returns
   * before this runs, so a later edit is never overwritten.
   */
  const vitals = await Vital.findOne({ visitId: visit._id, practiceId: scope.practiceId, deletedAt: null });
  const complaints = vitals?.complaints?.trim();
  if (complaints) {
    const { sections, editLog } = applyOps(
      wireSections(prescription.sections),
      [{ op: 'add', section: 'complaints', itemId: null, value: { text: complaints }, spanIds: [] }],
      { actorId: scope.actorId, origin: 'typed' },
    );
    prescription.set('sections', sections);
    prescription.editLog.push(...editLog);
    await prescription.save();
  }

  return { draft: prescription, created: true };
};

/**
 * Start a prescription, or hand back the one that is already open. 201 for a
 * new draft and 200 for the existing one, which `created` tells the
 * controller.
 *
 * Either way the visit moves from waiting to with_doctor, because that is what
 * has just become true.
 */
export const createPrescription = async (
  scope: Scope,
  body: CreatePrescriptionBody,
): Promise<{ prescription: PrescriptionView; created: boolean }> => {
  const { patient, visit } = await patientAndVisit(scope, body);
  const { draft, created } = await openDraft(scope, patient, visit, {
    source: body.source,
    printLanguage: body.printLanguage,
  });

  // The consultation is starting, whether this call opened the draft or
  // found it.
  await changeVisitStatus(scope, visit, 'with_doctor');

  const after = toPrescriptionView(draft);
  if (created) {
    await writeAudit(scope, { action: 'prescription.create', entity: 'prescription', entityId: draft._id, after });
  }
  return { prescription: after, created };
};

type Line = { text?: string; name?: string; strength?: string };

/** Two lines are the same line when they say the same thing, whatever their ids. */
const lineKey = (line: Line): string =>
  (line.name !== undefined ? `${line.name}|${line.strength ?? ''}` : (line.text ?? '')).trim().toLowerCase();

/**
 * The ops that add a template's lines to a draft.
 *
 * Only adds. A line the draft already has is skipped rather than doubled, and
 * the follow-up is taken from the template only when the draft has none, so
 * nothing the doctor has written is removed or changed.
 */
const templateOps = (draft: PrescriptionSections, template: PrescriptionSections): Op[] => {
  const ops: Op[] = [];

  LIST_SECTIONS.forEach((section) => {
    const present = new Set((draft[section] as Line[]).map(lineKey));
    (template[section] as (Line & { id: string })[]).forEach(({ id: _id, ...value }) => {
      const key = lineKey(value);
      if (present.has(key)) {
        return;
      }
      present.add(key);
      ops.push({ op: 'add', section, itemId: null, value, spanIds: [] });
    });
  });

  const asked = draft.followUp.inDays !== null || draft.followUp.date !== null || draft.followUp.note !== '';
  const offered = template.followUp.inDays !== null || template.followUp.note !== '';
  if (!asked && offered) {
    const { inDays, note, bookByAssistant } = template.followUp;
    ops.push({ op: 'update', section: 'followUp', itemId: null, value: { inDays, note, bookByAssistant }, spanIds: [] });
  }

  return ops;
};

/**
 * Start a prescription from one of the doctor's own templates, or add a
 * template to the draft the visit already has.
 *
 * A new draft is `source: 'template'`; adding to a draft that came from
 * somewhere else makes it `mixed`. The lines go through the ops engine like
 * every other change to a draft, so they are validated the same way and get
 * fresh item ids, and with the `template` origin, so they are not counted as
 * the doctor correcting the dictation. Every application counts as a use.
 */
export const createFromTemplate = async (
  scope: Scope,
  templateId: string,
  body: CreateFromTemplateBody,
): Promise<{ prescription: PrescriptionView; created: boolean }> => {
  const template = await findOwnTemplate(scope, templateId);
  const { patient, visit } = await patientAndVisit(scope, body);
  const { draft, created } = await openDraft(scope, patient, visit, { source: 'template', printLanguage: 'en_ur' });

  const current = wireSections(draft.sections);
  const ops = templateOps(current, wireSections(template.sections));
  if (ops.length > 0) {
    const { sections } = applyOps(current, ops, { actorId: scope.actorId, origin: 'template' });
    draft.set('sections', sections);
  }
  if (!created && draft.source !== 'template') {
    draft.source = 'mixed';
  }
  await draft.save();

  await changeVisitStatus(scope, visit, 'with_doctor');
  await markTemplateUsed(scope, template);

  const after = toPrescriptionView(draft);
  await writeAudit(
    scope,
    created
      ? {
          action: 'prescription.create',
          entity: 'prescription',
          entityId: draft._id,
          after: { ...after, templateId: String(template._id) },
        }
      : {
          action: 'prescription.update',
          entity: 'prescription',
          entityId: draft._id,
          before: { sections: current },
          after: { sections: after.sections, templateId: String(template._id), ops: ops.length },
        },
  );

  return { prescription: after, created };
};

/**
 * Fill in drugId for any medicine that does not have one, inserting the drug if
 * this is the first time anyone has prescribed it. This is what grows the
 * formulary from real use instead of from an import.
 */
const resolveMedicineDrugs = async (prescription: PrescriptionDoc, actorId: Types.ObjectId): Promise<void> => {
  const sections = wireSections(prescription.sections);
  if (sections.medicines.every((medicine) => medicine.drugId)) {
    return;
  }

  const medicines = await Promise.all(
    sections.medicines.map(async (medicine) => {
      if (medicine.drugId) {
        return medicine;
      }
      try {
        const drug = await findOrCreateDrug(medicine, actorId);
        return { ...medicine, drugId: String(drug._id) };
      } catch (error) {
        // A prescription is not worth failing over the formulary; the medicine
        // stays unlinked and will match next time.
        logger.warn(`could not resolve a drug for a medicine line: ${(error as Error).message}`);
        return medicine;
      }
    }),
  );

  prescription.set('sections', { ...sections, medicines });
};

/**
 * A typed edit. Goes through exactly the same validate-then-apply path as a
 * dictated one; the only difference is that this one is recorded in the edit
 * log, which is how the accuracy of the voice pipeline gets measured.
 */
export const patchPrescription = async (scope: Scope, id: string, body: PatchPrescriptionBody) => {
  const prescription = await getPrescriptionDoc(scope, id);
  assertDraft(prescription);

  const before = { sections: prescription.sections, printLanguage: prescription.printLanguage };

  if (body.ops.length > 0) {
    const { sections, editLog } = applyOps(wireSections(prescription.sections), body.ops, {
      actorId: scope.actorId,
      origin: 'typed',
    });
    prescription.set('sections', sections);
    prescription.editLog.push(...editLog);

    // A draft that started as dictation and is then typed into is both.
    if (prescription.source === 'voice' && editLog.length > 0) {
      prescription.source = 'mixed';
    }
  }

  if (body.printLanguage !== undefined) {
    prescription.printLanguage = body.printLanguage;
  }

  await resolveMedicineDrugs(prescription, scope.actorId);
  await prescription.save();

  const after = toPrescriptionView(prescription);
  await writeAudit(scope, {
    action: 'prescription.update',
    entity: 'prescription',
    entityId: prescription._id,
    before,
    after: { sections: after.sections, printLanguage: after.printLanguage, ops: body.ops.length },
  });

  return after;
};

/**
 * Everything that has to be frozen onto the page at approval - and, for a
 * draft preview, built live, because there is nothing frozen yet.
 */
const buildLetterheadSnapshot = async (prescription: PrescriptionDoc, doctorName: string): Promise<LetterheadSnapshot> => {
  const [location, practice] = await Promise.all([
    Location.findById(prescription.locationId),
    Practice.findById(prescription.practiceId),
  ]);

  return {
    locationName: location?.name ?? '',
    address: location?.address ?? '',
    phone: location?.phone ?? '',
    timings: location?.timings ?? [],
    letterhead: location?.letterhead ?? { en: '', ur: '' },
    doctorName,
    qualifications: practice?.qualifications ?? [],
    speciality: practice?.speciality ?? '',
    pmdcNo: practice?.pmdcNo ?? '',
  };
};

/**
 * The tests this prescription orders, one `labs` row per line, so each can
 * carry a result later and the patient's history can show what was ordered.
 *
 * A revision orders again whatever it still wants, so the rows of the version
 * it replaces are retired first - except a row somebody has recorded a result
 * or a file against, which is part of the patient's record now.
 */
const recordOrderedLabs = async (scope: Scope, prescription: PrescriptionDoc): Promise<void> => {
  if (prescription.previousVersionId) {
    await Lab.updateMany(
      {
        practiceId: scope.practiceId,
        prescriptionId: prescription.previousVersionId,
        result: '',
        fileKey: null,
        deletedAt: null,
      },
      { $set: { deletedAt: new Date() } },
    );
  }

  const { labs } = wireSections(prescription.sections);
  if (labs.length === 0) {
    return;
  }
  await Lab.insertMany(
    labs.map((lab) => ({
      practiceId: scope.practiceId,
      patientId: prescription.patientId,
      prescriptionId: prescription._id,
      name: lab.text,
      result: '',
      fileKey: null,
      createdBy: scope.actorId,
    })),
  );
};

/**
 * The signature. After this the document is immutable, the number is minted
 * from the practice counter, and the letterhead is frozen.
 */
export const approvePrescription = async (scope: Scope, id: string, doctorName: string) => {
  const prescription = await getPrescriptionDoc(scope, id);
  assertDraft(prescription);

  const sections = wireSections(prescription.sections);
  if (isEmpty(sections)) {
    throw new AppError('VALIDATION_ERROR', 'There is nothing on this prescription to approve.');
  }

  /**
   * A flag is the pipeline saying it was not sure - an unclear dose, a drug it
   * could not place. Approving is the doctor's signature on a legal document,
   * so every uncertain line has to have been looked at first. The app greys
   * the button out; this is the part that cannot be got around.
   */
  const flagged = sections.medicines.filter((medicine) => medicine.flags.length > 0);
  if (flagged.length > 0) {
    throw new AppError(
      'RX_HAS_FLAGS',
      `${flagged.length === 1 ? 'A medicine needs' : `${flagged.length} medicines need`} checking before this can be approved.`,
      { itemIds: flagged.map((medicine) => medicine.id) },
    );
  }

  const approvedAt = new Date();
  prescription.number = await nextPrescriptionNumber(scope.practiceId, approvedAt);
  prescription.letterheadSnapshot = await buildLetterheadSnapshot(prescription, doctorName);
  prescription.status = 'approved';
  prescription.approvedAt = approvedAt;
  prescription.approvedBy = scope.actorId;
  // What the printout's QR code points at, in the same write as the signature,
  // so there is never an approved prescription a pharmacist cannot check.
  prescription.verificationCode = newVerificationCode();

  await resolveMedicineDrugs(prescription, scope.actorId);
  await prescription.save();

  // Dictation audio is kept for a while after approval and then deleted. The
  // clock starts here, because that is the point at which the recording has
  // served its purpose.
  const practice = await Practice.findById(scope.practiceId);
  const retentionDays = practice?.settings.audioRetentionDays ?? 30;
  await VoiceSession.updateOne(
    { prescriptionId: prescription._id },
    { $set: { status: 'closed', audioDeleteAfter: addDays(approvedAt, retentionDays) } },
  );

  /**
   * Signing version 2 is what retires version 1, and in that order on purpose.
   * There are no transactions here, so if the second write failed the choice is
   * between leaving two approved versions and leaving none - and two, which is
   * visible and fixable, beats a patient holding nothing valid.
   */
  if (prescription.previousVersionId) {
    const superseded = await Prescription.findOneAndUpdate(
      { _id: prescription.previousVersionId, practiceId: scope.practiceId, status: 'approved' },
      { $set: { status: 'superseded' } },
    );
    if (superseded) {
      await writeAudit(scope, {
        action: 'prescription.supersede',
        entity: 'prescription',
        entityId: superseded._id,
        before: { status: 'approved' },
        after: { status: 'superseded', supersededBy: String(prescription._id) },
      });
    }
  }

  await recordOrderedLabs(scope, prescription);

  /**
   * Signing the prescription is the end of the consultation, so the visit is
   * done. On the server rather than in the app, so it happens for every client
   * and cannot half happen because a second request was lost.
   */
  if (prescription.visitId) {
    const visit = await Visit.findOne({
      _id: prescription.visitId,
      practiceId: scope.practiceId,
      deletedAt: null,
    });
    if (visit) {
      await changeVisitStatus(scope, visit, 'done');
    }
  }

  const after = toPrescriptionView(prescription);
  await writeAudit(scope, {
    action: 'prescription.approve',
    entity: 'prescription',
    entityId: prescription._id,
    after: { number: prescription.number, version: prescription.version },
  });
  emit('prescription.approved', {
    practiceId: scope.practiceId,
    locationId: prescription.locationId,
    prescriptionId: prescription._id,
    patientId: prescription.patientId,
    number: prescription.number,
    actorId: scope.actorId,
  });

  return after;
};

/**
 * Revising an approved prescription opens version 2 as a draft.
 *
 * Version 1 stays approved until version 2 is signed. Superseding it straight
 * away meant that a doctor who started a revision and was called away left the
 * patient with no valid prescription at all: version 1 retired, version 2
 * never approved. Nothing about version 1 changes here, so what the patient is
 * holding stays exactly readable, letterhead included.
 *
 * The new draft carries no number: it gets its own when it is approved, and
 * that is also the moment version 1 becomes superseded.
 */
export const revisePrescription = async (scope: Scope, id: string, body: RevisePrescriptionBody) => {
  const previous = await getPrescriptionDoc(scope, id);

  if (previous.status === 'superseded') {
    throw new AppError('RX_ALREADY_SUPERSEDED', 'That version has already been revised.');
  }
  if (previous.status !== 'approved') {
    throw new AppError('RX_NOT_APPROVED', 'Only an approved prescription needs revising; edit the draft instead.');
  }

  // One revision at a time. The index below decides it even when two taps
  // arrive together; this is the readable answer for the ordinary case.
  const alreadyOpen = await prescriptions.findOne(scope, { previousVersionId: previous._id, status: 'draft' });
  if (alreadyOpen) {
    throw new AppError('CONFLICT', 'This prescription is already being revised.', {
      revisionId: String(alreadyOpen._id),
    });
  }

  let revision: PrescriptionDoc;
  try {
    revision = await prescriptions.create(scope, {
      patientId: previous.patientId,
      visitId: previous.visitId,
      doctorId: scope.actorId,
      status: 'draft',
      source: previous.source,
      printLanguage: previous.printLanguage,
      sections: wireSections(previous.sections),
      version: previous.version + 1,
      previousVersionId: previous._id,
      number: null,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      const winner = await prescriptions.findOne(scope, { previousVersionId: previous._id, status: 'draft' });
      throw new AppError('CONFLICT', 'This prescription is already being revised.', {
        ...(winner ? { revisionId: String(winner._id) } : {}),
      });
    }
    throw error;
  }

  const after = toPrescriptionView(revision);
  await writeAudit(scope, {
    action: 'prescription.revise',
    entity: 'prescription',
    entityId: revision._id,
    before: { id: String(previous._id), version: previous.version, status: previous.status },
    after: { version: revision.version, reason: body.reason },
  });
  emit('prescription.revised', {
    practiceId: scope.practiceId,
    locationId: revision.locationId,
    prescriptionId: revision._id,
    previousVersionId: previous._id,
    version: revision.version,
    actorId: scope.actorId,
  });

  return after;
};

/**
 * The print file, as a short-lived signed URL.
 *
 * Rendered on first ask rather than at approval, so an approval never waits on
 * a renderer, and the app can simply ask again.
 */
export const prescriptionPdf = async (scope: Scope, id: string): Promise<SignedUrlView & { driver: string }> => {
  const prescription = await getPrescriptionDoc(scope, id);

  if (prescription.status === 'draft') {
    throw new AppError('RX_NOT_APPROVED', 'A draft cannot be printed. Approve it first.');
  }

  if (!prescription.pdfKey) {
    const patient = await Patient.findById(prescription.patientId);
    const age = patient?.dob ? ageFromDob(patient.dob) : (patient?.age ?? null);
    prescription.pdfKey = await renderPrescription(prescription, patient?.name ?? '', age);
    await prescription.save();
  }

  const signed = await signedGetUrl(prescription.pdfKey);
  await writeAudit(scope, {
    action: 'prescription.print',
    entity: 'prescription',
    entityId: prescription._id,
    after: { number: prescription.number },
  });

  return { ...signed, driver: prescription.pdfKey.endsWith('.pdf') ? 'pdf' : 'html' };
};

/**
 * Abandon a draft.
 *
 * The way out of a revision somebody started and thought better of: the draft
 * becomes cancelled and the version it was revising is left approved, exactly
 * as the patient is holding it. Also how a consultation that produced nothing
 * is closed, which frees the one-draft-per-visit slot.
 *
 * Only a draft. An approved prescription is a document somebody has, and the
 * way to withdraw it is to revise it.
 */
export const cancelPrescription = async (scope: Scope, id: string) => {
  const prescription = await getPrescriptionDoc(scope, id);

  if (prescription.status === 'cancelled') {
    return toPrescriptionView(prescription);
  }
  if (prescription.status === 'approved') {
    throw new AppError('RX_LOCKED', 'This prescription is approved. Revise it rather than cancelling it.');
  }
  if (prescription.status !== 'draft') {
    throw new AppError('RX_NOT_DRAFT', `A ${prescription.status} prescription cannot be cancelled.`);
  }

  prescription.status = 'cancelled';
  await prescription.save();

  const after = toPrescriptionView(prescription);
  await writeAudit(scope, {
    action: 'prescription.cancel',
    entity: 'prescription',
    entityId: prescription._id,
    before: { status: 'draft', version: prescription.version },
    after: { status: 'cancelled', revising: prescription.previousVersionId ? String(prescription.previousVersionId) : null },
  });

  return after;
};

/**
 * What the page will look like, before it is signed.
 *
 * Deliberately separate from /pdf: that one refuses a draft, because a
 * prescription that has not been approved is not a prescription, and a file
 * that can be mistaken for one must not be sitting at a stable URL. The
 * preview is marked DRAFT, carries no number, and is never stored as the
 * prescription's pdfKey.
 *
 * Works on an approved prescription too, so the same button does the same
 * thing on both sides of the signature.
 */
export const previewPrescription = async (scope: Scope, id: string): Promise<SignedUrlView & { driver: string }> => {
  const prescription = await getPrescriptionDoc(scope, id);

  const patient = await Patient.findById(prescription.patientId);
  const age = patient?.dob ? ageFromDob(patient.dob) : (patient?.age ?? null);

  // A draft has no snapshot, so the letterhead is read as it stands today.
  const letterhead = await buildLetterheadSnapshot(prescription, (await User.findById(prescription.doctorId))?.name ?? '');
  const key = await renderPreview(prescription, patient?.name ?? '', age, letterhead);

  const signed = await signedGetUrl(key);
  await writeAudit(scope, {
    action: 'prescription.preview',
    entity: 'prescription',
    entityId: prescription._id,
    after: { status: prescription.status, version: prescription.version },
  });

  return { ...signed, driver: key.endsWith('.pdf') ? 'pdf' : 'html' };
};

export default {
  listPrescriptions,
  getPrescription,
  createPrescription,
  createFromTemplate,
  patchPrescription,
  approvePrescription,
  revisePrescription,
  cancelPrescription,
  prescriptionPdf,
  previewPrescription,
  toPrescriptionView,
};
