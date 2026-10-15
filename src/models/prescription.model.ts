import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import { bilingualSubSchema, timingSubSchema } from './subSchemas';
import type {
  EditLogEntry,
  LetterheadSnapshot,
  PrescriptionSections,
  PrescriptionSource,
  PrescriptionStatus,
  PrintLanguage,
} from '../shared/prescription.schema';

/**
 * The document the patient walks out with.
 *
 * Once approved it is immutable. An edit creates version 2 with
 * `previousVersionId` set and marks version 1 'superseded'; only a 'draft' ever
 * changes. `letterheadSnapshot` is frozen at approval so that editing a
 * location afterwards cannot alter a page that has already been printed.
 */
export interface IPrescription {
  practiceId: Types.ObjectId;
  locationId: Types.ObjectId;
  patientId: Types.ObjectId;
  visitId: Types.ObjectId | null;
  doctorId: Types.ObjectId;
  /** `RX-2026-000418`, from a per-practice counter. Null until approval. */
  number: string | null;
  version: number;
  previousVersionId: Types.ObjectId | null;
  status: PrescriptionStatus;
  source: PrescriptionSource;
  sections: PrescriptionSections;
  printLanguage: PrintLanguage;
  letterheadSnapshot: LetterheadSnapshot | null;
  approvedAt: Date | null;
  approvedBy: Types.ObjectId | null;
  pdfKey: string | null;
  /** Every doctor correction, which is how AI accuracy gets measured. */
  editLog: EditLogEntry[];
  createdBy: Types.ObjectId;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PrescriptionDoc = HydratedDocument<IPrescription>;

const textItemSubSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    sourceSpanIds: { type: [String], default: [] },
  },
  { _id: false },
);

const diagnosisItemSubSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    code: { type: String, default: null },
    sourceSpanIds: { type: [String], default: [] },
  },
  { _id: false },
);

const medicineItemSubSchema = new Schema(
  {
    id: { type: String, required: true },
    drugId: { type: Schema.Types.ObjectId, ref: 'Drug', default: null },
    name: { type: String, required: true },
    strength: { type: String, default: '' },
    form: { type: String, default: 'tab' },
    route: { type: String, default: 'oral' },
    // Either { m, a, n } or { sos: true }. Two shapes rather than nullable
    // counts, so Mixed here and zod on the way in.
    pattern: { type: Schema.Types.Mixed, default: () => ({ m: 1, a: 0, n: 0 }) },
    timing: { type: String, default: 'any' },
    durationDays: { type: Number, default: 0 },
    instructionEn: { type: String, default: '' },
    instructionUr: { type: String, default: '' },
    flags: { type: [String], default: [] },
    correctedBySpeech: { type: Boolean, default: false },
    sourceSpanIds: { type: [String], default: [] },
  },
  { _id: false },
);

const followUpSubSchema = new Schema(
  {
    inDays: { type: Number, default: null },
    date: { type: String, default: null },
    note: { type: String, default: '' },
    // "Ask the assistant to book it", which is what puts it on her list.
    bookByAssistant: { type: Boolean, default: true },
  },
  { _id: false },
);

const letterheadSnapshotSubSchema = new Schema<LetterheadSnapshot>(
  {
    locationName: { type: String, default: '' },
    address: { type: String, default: '' },
    phone: { type: String, default: '' },
    timings: { type: [timingSubSchema], default: [] },
    letterhead: { type: bilingualSubSchema, default: () => ({ en: '', ur: '' }) },
    doctorName: { type: String, default: '' },
    qualifications: { type: [String], default: [] },
    speciality: { type: String, default: '' },
    pmdcNo: { type: String, default: '' },
  },
  { _id: false },
);

const editLogEntrySubSchema = new Schema(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    section: { type: String, required: true },
    itemId: { type: String, default: null },
    from: { type: Schema.Types.Mixed, default: null },
    to: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const prescriptionSchema = new Schema<IPrescription>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    visitId: { type: Schema.Types.ObjectId, ref: 'Visit', default: null },
    doctorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    number: { type: String, default: null },
    version: { type: Number, default: 1 },
    previousVersionId: { type: Schema.Types.ObjectId, ref: 'Prescription', default: null },
    status: { type: String, enum: ['draft', 'approved', 'superseded', 'cancelled'], default: 'draft' },
    source: { type: String, enum: ['voice', 'typed', 'template', 'mixed'], default: 'typed' },
    sections: {
      complaints: { type: [textItemSubSchema], default: [] },
      history: { type: [textItemSubSchema], default: [] },
      examination: { type: [textItemSubSchema], default: [] },
      diagnosis: { type: [diagnosisItemSubSchema], default: [] },
      medicines: { type: [medicineItemSubSchema], default: [] },
      labs: { type: [textItemSubSchema], default: [] },
      dietEat: { type: [textItemSubSchema], default: [] },
      dietAvoid: { type: [textItemSubSchema], default: [] },
      advice: { type: [textItemSubSchema], default: [] },
      followUp: {
        type: followUpSubSchema,
        default: () => ({ inDays: null, date: null, note: '', bookByAssistant: true }),
      },
    },
    printLanguage: { type: String, enum: ['en', 'en_ur'], default: 'en_ur' },
    letterheadSnapshot: { type: letterheadSnapshotSubSchema, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    pdfKey: { type: String, default: null },
    editLog: { type: [editLogEntrySubSchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

prescriptionSchema.plugin(toJSON);
prescriptionSchema.plugin(paginate);

prescriptionSchema.index({ practiceId: 1, patientId: 1, createdAt: -1 });
/**
 * Unique, because a prescription number is what a patient and a pharmacist
 * quote back about a legal document.
 *
 * A partial filter and not `sparse`: on a compound index, sparse only skips a
 * document that is missing every indexed field, so with practiceId present two
 * drafts - both with number null - would collide on the null. Restricting the
 * index to documents whose number is a string leaves drafts out of it
 * altogether, which is what lets a practice hold more than one at a time.
 */
prescriptionSchema.index(
  { practiceId: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'string' } } },
);
prescriptionSchema.index({ practiceId: 1, locationId: 1, status: 1, createdAt: -1 });

/**
 * One open draft per visit, held by the database rather than by a check that
 * two simultaneous creates would both pass - a double tap, or the doctor
 * opening the same patient on a second device, must not produce two
 * half-written prescriptions for one consultation.
 *
 * Partial on both counts: only drafts, because an approved prescription does
 * not stop the next one, and only where visitId is actually an id, because
 * several prescriptions written outside a visit all carry null and must not
 * collide on it.
 */
/**
 * One open revision per prescription, for the same reason as one draft per
 * visit: two taps must not start two revisions of the same page.
 */
prescriptionSchema.index(
  { practiceId: 1, previousVersionId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'draft', previousVersionId: { $type: 'objectId' } } },
);

prescriptionSchema.index(
  { practiceId: 1, visitId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'draft', visitId: { $type: 'objectId' } } },
);

export const Prescription = mongoose.model<IPrescription, PaginateModel<IPrescription>>(
  'Prescription',
  prescriptionSchema,
  'prescriptions',
);
export default Prescription;
