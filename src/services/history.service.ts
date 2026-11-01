import type { PipelineStage, Types } from 'mongoose';
import {
  Lab,
  Prescription,
  Report,
  Visit,
  Vital,
  type ILab,
  type IPrescription,
  type IReport,
  type IVisit,
  type IVital,
  type LabDoc,
  type PrescriptionDoc,
  type ReportDoc,
  type VisitDoc,
  type VitalDoc,
} from '../models';
import { BaseRepository, type Scope } from '../core/db';
import {
  historyKindSchema,
  type HistoryItemView,
  type HistoryKind,
  type HistoryLab,
  type HistoryPrescription,
  type HistoryReport,
  type HistoryVisit,
  type ListHistoryQuery,
} from '../shared/history.schema';
import type { PageMeta } from '../shared/response';
import { findPatientOrFail } from './patient.service';
import { wireSections } from './prescriptionOps.service';
import { toVitalsView } from './vitals.service';

/**
 * Practice-wide on purpose, like the doctor's patient search: a patient seen
 * at two locations has one history. So none of these repositories is
 * location-scoped, including the ones whose collections are everywhere else.
 * The route is doctor-only, and a doctor may see every location of their own
 * practice; the patient is still reached through findPatientOrFail, like
 * everywhere else.
 */
const visits = new BaseRepository<IVisit>(Visit);
const prescriptions = new BaseRepository<IPrescription>(Prescription);
const labs = new BaseRepository<ILab>(Lab);
const reports = new BaseRepository<IReport>(Report);
const vitals = new BaseRepository<IVital>(Vital);

/** One row of the merged timeline before it is filled in. */
interface Entry {
  _id: Types.ObjectId;
  at: Date;
  kind: HistoryKind;
}

interface Page {
  items: Entry[];
  total: { n: number }[];
}

/**
 * Where each kind comes from. A cancelled draft is a consultation that
 * produced nothing, so it is not part of anybody's history.
 */
const sourcesFor = (scope: Scope, patientId: Types.ObjectId) => ({
  visit: {
    collection: Visit.collection.collectionName,
    match: visits.scopedFilter(scope, { patientId }),
    aggregate: (pipeline: PipelineStage[]) => Visit.aggregate<Page>(pipeline).exec(),
  },
  prescription: {
    collection: Prescription.collection.collectionName,
    match: prescriptions.scopedFilter(scope, { patientId, status: { $ne: 'cancelled' } }),
    aggregate: (pipeline: PipelineStage[]) => Prescription.aggregate<Page>(pipeline).exec(),
  },
  lab: {
    collection: Lab.collection.collectionName,
    match: labs.scopedFilter(scope, { patientId }),
    aggregate: (pipeline: PipelineStage[]) => Lab.aggregate<Page>(pipeline).exec(),
  },
  report: {
    collection: Report.collection.collectionName,
    match: reports.scopedFilter(scope, { patientId }),
    aggregate: (pipeline: PipelineStage[]) => Report.aggregate<Page>(pipeline).exec(),
  },
});

const toHistoryVisit = (visit: VisitDoc, recorded: VitalDoc | undefined): HistoryVisit => ({
  kind: 'visit',
  id: String(visit._id),
  at: visit.createdAt,
  locationId: String(visit.locationId),
  date: visit.date,
  token: visit.token,
  reason: visit.reason,
  status: visit.status,
  vitals: recorded ? toVitalsView(recorded) : null,
});

const toHistoryPrescription = (prescription: PrescriptionDoc): HistoryPrescription => {
  const sections = wireSections(prescription.sections);
  return {
    kind: 'prescription',
    id: String(prescription._id),
    at: prescription.createdAt,
    number: prescription.number,
    version: prescription.version,
    status: prescription.status,
    diagnosis: sections.diagnosis.map((item) => item.text),
    medicineNames: sections.medicines.map((item) => item.name),
    hasPdf: prescription.pdfKey !== null,
  };
};

const toHistoryLab = (lab: LabDoc): HistoryLab => ({
  kind: 'lab',
  id: String(lab._id),
  at: lab.createdAt,
  name: lab.name,
  result: lab.result,
  prescriptionId: lab.prescriptionId ? String(lab.prescriptionId) : null,
  hasFile: lab.fileKey !== null,
});

const toHistoryReport = (report: ReportDoc): HistoryReport => ({
  kind: 'report',
  id: String(report._id),
  at: report.createdAt,
  type: report.type,
  testName: report.testName,
  testDate: report.testDate,
  pages: report.pageKeys.length,
  reviewedAt: report.reviewedAt,
});

/**
 * One patient's timeline, newest first: visits with their vitals,
 * prescriptions, ordered labs and reports, in one column.
 *
 * The merge and the paging happen in the database. Each kind contributes only
 * its id and `at` to a `$unionWith`; the union is sorted and one page is cut
 * from it, and then just that page is read in full. So "newest" means the same
 * thing on every page, and a deep page does not drag every row of every kind
 * across the wire.
 */
export const getHistory = async (
  scope: Scope,
  patientId: string,
  query: ListHistoryQuery,
): Promise<{ items: HistoryItemView[]; meta: PageMeta }> => {
  const patient = await findPatientOrFail(scope, patientId);

  const sources = sourcesFor(scope, patient._id);
  const kinds: HistoryKind[] = query.kind ? [query.kind] : [...historyKindSchema.options];
  const stages = (kind: HistoryKind): [PipelineStage.Match, PipelineStage.Project] => [
    { $match: sources[kind].match },
    { $project: { _id: 1, at: '$createdAt', kind: { $literal: kind } } },
  ];

  const [first, ...rest] = kinds;
  const [page] = await sources[first].aggregate([
    ...stages(first),
    ...rest.map((kind) => ({ $unionWith: { coll: sources[kind].collection, pipeline: stages(kind) } })),
    // _id breaks a tie, so two things stamped in the same millisecond keep
    // one order from page to page.
    { $sort: { at: -1, _id: -1 } },
    {
      $facet: {
        items: [{ $skip: (query.page - 1) * query.limit }, { $limit: query.limit }],
        total: [{ $count: 'n' }],
      },
    },
  ]);

  const entries = page?.items ?? [];
  const total = page?.total[0]?.n ?? 0;
  const idsOf = (kind: HistoryKind) => entries.filter((entry) => entry.kind === kind).map((entry) => entry._id);

  const [visitDocs, prescriptionDocs, labDocs, reportDocs] = await Promise.all([
    visits.find(scope, { _id: { $in: idsOf('visit') } }),
    prescriptions.find(scope, { _id: { $in: idsOf('prescription') } }),
    labs.find(scope, { _id: { $in: idsOf('lab') } }),
    reports.find(scope, { _id: { $in: idsOf('report') } }),
  ]);
  const vitalDocs = await vitals.find(scope, { visitId: { $in: visitDocs.map((visit) => visit._id) } });
  const vitalsByVisit = new Map(vitalDocs.map((recorded) => [String(recorded.visitId), recorded]));

  const built = new Map<string, HistoryItemView>([
    ...visitDocs.map((visit) => [String(visit._id), toHistoryVisit(visit, vitalsByVisit.get(String(visit._id)))] as const),
    ...prescriptionDocs.map((prescription) => [String(prescription._id), toHistoryPrescription(prescription)] as const),
    ...labDocs.map((lab) => [String(lab._id), toHistoryLab(lab)] as const),
    ...reportDocs.map((report) => [String(report._id), toHistoryReport(report)] as const),
  ]);

  return {
    // In the order the database sorted them. A row deleted between the two
    // reads is simply left out.
    items: entries.map((entry) => built.get(String(entry._id))).filter((item): item is HistoryItemView => !!item),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

export default { getHistory };
