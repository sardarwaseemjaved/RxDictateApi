import { Types } from 'mongoose';
import logger from '../config/logger';
import {
  Location,
  Patient,
  Practice,
  Prescription,
  User,
  Visit,
  Vital,
  VoiceSession,
  type IPrescription,
  type PrescriptionDoc,
} from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import { signedGetUrl } from '../core/storage';
import type {
  CreatePrescriptionBody,
  LetterheadSnapshot,
  ListPrescriptionsQuery,
  PatchPrescriptionBody,
  PrescriptionView,
  RevisePrescriptionBody,
} from '../shared/prescription.schema';
import { prescriptionSectionsSchema, prescriptionViewSchema } from '../shared/prescription.schema';
import type { PageMeta, SignedUrlView } from '../shared';
import { addDays, ageFromDob } from '../utils/time';
import { applyOps, isEmpty, wireSections } from './prescriptionOps.service';
import { nextPrescriptionNumber } from './counter.service';
import { findOrCreateDrug } from './drug.service';
import { renderPrescription, renderPreview } from './pdf.service';

const prescriptions = new BaseRepository<IPrescription>(Prescription, { locationScoped: true });

/**
 * The shape the app reads, parsed through the contract rather than assembled
 * to look like it.
 *
 * Going through the schema is what stops the two drifting: a field added to
 * the contract and not filled in here is a type error, and anything returned
 * that the contract does not declare - a mongoose internal, the practice id -
 * is stripped before it leaves.
 */
export const toPrescriptionView = (prescription: PrescriptionDoc): PrescriptionView =>
  prescriptionViewSchema.parse({
    id: String(prescription._id),
    locationId: String(prescription.locationId),
    patientId: String(prescription.patientId),
    visitId: prescription.visitId ? String(prescription.visitId) : null,
    doctorId: String(prescription.doctorId),
    number: prescription.number,
    version: prescription.version,
    previousVersionId: prescription.previousVersionId ? String(prescription.previousVersionId) : null,
    status: prescription.status,
    source: prescription.source,
    sections: wireSections(prescription.sections),
    printLanguage: prescription.printLanguage,
    letterheadSnapshot: prescription.letterheadSnapshot,
    approvedAt: prescription.approvedAt,
    approvedBy: prescription.approvedBy ? String(prescription.approvedBy) : null,
    hasPdf: prescription.pdfKey !== null,
    editCount: prescription.editLog.length,
    createdAt: prescription.createdAt,
    updatedAt: prescription.updatedAt,
  });

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

export const listPrescriptions = async (
  scope: Scope,
  query: ListPrescriptionsQuery,
): Promise<{ prescriptions: ReturnType<typeof toPrescriptionView>[]; meta: PageMeta }> => {
  const filter: Record<string, unknown> = {};
  if (query.patientId) filter.patientId = new Types.ObjectId(query.patientId);
  if (query.status) filter.status = query.status;

  const result = await prescriptions.paginate(scope, filter, {
    page: query.page,
    limit: query.limit,
    sortBy: 'createdAt:desc',
  });

  return {
    prescriptions: result.results.map(toPrescriptionView),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

export const getPrescription = async (scope: Scope, id: string) => toPrescriptionView(await getPrescriptionDoc(scope, id));

/**
 * Start a prescription, or hand back the one that is already open.
 *
 * A visit has one draft at a time. A double tap, or the doctor opening the
 * same patient on a second device, must not produce two half-written
 * prescriptions for one consultation - so an existing draft for the visit
 * comes back untouched, the same way adding a patient to today's list twice
 * returns the visit they are already on. `created` tells the controller
 * whether to answer 201 or 200.
 */
export const createPrescription = async (
  scope: Scope,
  body: CreatePrescriptionBody,
): Promise<{ prescription: PrescriptionView; created: boolean }> => {
  const patient = await Patient.findOne({ _id: body.patientId, practiceId: scope.practiceId, deletedAt: null });
  if (!patient) {
    throw AppError.notFound('Patient');
  }

  let visit = null;
  if (body.visitId) {
    visit = await Visit.findOne({ _id: body.visitId, practiceId: scope.practiceId, deletedAt: null });
    if (!visit) {
      throw AppError.notFound('Visit');
    }

    const open = await prescriptions.findOne(scope, { visitId: visit._id, status: 'draft' });
    if (open) {
      return { prescription: toPrescriptionView(open), created: false };
    }
  }

  let prescription: PrescriptionDoc;
  try {
    prescription = await prescriptions.create(scope, {
      patientId: patient._id,
      visitId: visit ? visit._id : null,
      doctorId: scope.actorId,
      status: 'draft',
      source: body.source,
      printLanguage: body.printLanguage,
      sections: prescriptionSectionsSchema.parse({}),
      version: 1,
    });
  } catch (error) {
    // The read above and this write are not one operation, so two devices can
    // both get past it. The unique index is what actually decides, and the
    // one that loses reads back the draft the winner made.
    if ((error as { code?: number }).code === 11000 && visit) {
      const open = await prescriptions.findOne(scope, { visitId: visit._id, status: 'draft' });
      if (open) {
        return { prescription: toPrescriptionView(open), created: false };
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
  if (visit) {
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
  }

  const after = toPrescriptionView(prescription);
  await writeAudit(scope, { action: 'prescription.create', entity: 'prescription', entityId: prescription._id, after });
  return { prescription: after, created: true };
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
    pmdcNo: practice?.pmdcNo ?? '',
  };
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
 * Revising an approved prescription makes version 2 and supersedes version 1.
 *
 * Nothing about version 1 changes except its status, so what the patient was
 * handed stays exactly readable - including the letterhead it was printed with.
 * The new draft carries no number: it gets its own when it is approved.
 */
export const revisePrescription = async (scope: Scope, id: string, body: RevisePrescriptionBody) => {
  const previous = await getPrescriptionDoc(scope, id);

  if (previous.status === 'superseded') {
    throw new AppError('RX_ALREADY_SUPERSEDED', 'That version has already been revised.');
  }
  if (previous.status !== 'approved') {
    throw new AppError('RX_NOT_APPROVED', 'Only an approved prescription needs revising; edit the draft instead.');
  }

  const revision = await prescriptions.create(scope, {
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

  previous.status = 'superseded';
  await previous.save();

  const after = toPrescriptionView(revision);
  await writeAudit(scope, {
    action: 'prescription.revise',
    entity: 'prescription',
    entityId: revision._id,
    before: { id: String(previous._id), version: previous.version, status: 'approved' },
    after: { version: revision.version, reason: body.reason },
  });
  await writeAudit(scope, {
    action: 'prescription.supersede',
    entity: 'prescription',
    entityId: previous._id,
    before: { status: 'approved' },
    after: { status: 'superseded', supersededBy: String(revision._id) },
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
  patchPrescription,
  approvePrescription,
  revisePrescription,
  prescriptionPdf,
  previewPrescription,
  toPrescriptionView,
};
