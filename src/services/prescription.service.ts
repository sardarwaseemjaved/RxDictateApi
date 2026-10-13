import { Types } from 'mongoose';
import logger from '../config/logger';
import {
  Location,
  Patient,
  Practice,
  Prescription,
  Visit,
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
  RevisePrescriptionBody,
} from '../shared/prescription.schema';
import { prescriptionSectionsSchema } from '../shared/prescription.schema';
import type { PageMeta, SignedUrlView } from '../shared';
import { addDays, ageFromDob } from '../utils/time';
import { applyOps, isEmpty, wireSections } from './prescriptionOps.service';
import { nextPrescriptionNumber } from './counter.service';
import { findOrCreateDrug } from './drug.service';
import { renderPrescription } from './pdf.service';

const prescriptions = new BaseRepository<IPrescription>(Prescription, { locationScoped: true });

/** The shape the app reads. Mongoose internals and the practice id stay here. */
export const toPrescriptionView = (prescription: PrescriptionDoc) => ({
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
  sections: prescription.sections,
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

export const createPrescription = async (scope: Scope, body: CreatePrescriptionBody) => {
  const patient = await Patient.findOne({ _id: body.patientId, practiceId: scope.practiceId, deletedAt: null });
  if (!patient) {
    throw AppError.notFound('Patient');
  }

  if (body.visitId) {
    const visit = await Visit.findOne({ _id: body.visitId, practiceId: scope.practiceId, deletedAt: null });
    if (!visit) {
      throw AppError.notFound('Visit');
    }
  }

  const prescription = await prescriptions.create(scope, {
    patientId: patient._id,
    visitId: body.visitId ? new Types.ObjectId(body.visitId) : null,
    doctorId: scope.actorId,
    status: 'draft',
    source: body.source,
    printLanguage: body.printLanguage,
    sections: prescriptionSectionsSchema.parse({}),
    version: 1,
  });

  const after = toPrescriptionView(prescription);
  await writeAudit(scope, { action: 'prescription.create', entity: 'prescription', entityId: prescription._id, after });
  return after;
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

/** Everything that has to be frozen onto the page at approval. */
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

  if (isEmpty(wireSections(prescription.sections))) {
    throw new AppError('VALIDATION_ERROR', 'There is nothing on this prescription to approve.');
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

export default {
  listPrescriptions,
  getPrescription,
  createPrescription,
  patchPrescription,
  approvePrescription,
  revisePrescription,
  prescriptionPdf,
  toPrescriptionView,
};
