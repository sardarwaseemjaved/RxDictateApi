import { Types, type FilterQuery } from 'mongoose';
import type { z, ZodType } from 'zod';
import {
  Drug,
  DrugList,
  DrugUsage,
  Practice,
  QUEUE_RANK,
  Submission,
  drugKeys,
  identityKeyOf,
  type DrugDoc,
  type IDrug,
  type ISubmission,
  type PracticeDoc,
  type SubmissionDoc,
} from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { PageMeta } from '../shared/response';
import type { OrganisationType } from '../shared/roles';
import {
  SUBMISSION_PAYLOAD_SCHEMAS,
  type ApproveSubmissionBody,
  type ListSubmissionsQuery,
  type ProposalPayload,
  type RejectSubmissionBody,
  type RequestChangesBody,
  type ResubmitSubmissionBody,
  type SubmissionDetailView,
  type SubmissionStep,
  type SubmissionView,
} from '../shared/submission.schema';
import type { SubmissionStatus, SubmissionType } from '../shared/submissionStatus';
import type { ClaimProductBody, ProductFields, UpdateProductBody } from '../shared/company.schema';
import type { CompanyAnnouncementPayload } from '../shared/announcement.schema';
import { nationalRows, toDrugView } from './drugAccess.service';
import { announceMedicines } from './drugList.service';
import { createFromSubmission } from './announcement.service';
import { allowanceViewFor } from './announcementAllowance.service';
import { preparePayload } from './companyAnnouncement.service';

type Audited = Scope & { requestId?: string | null };

/**
 * The review queue.
 *
 * Anything sent from outside the platform that would change what a doctor
 * sees waits here until a reviewer approves it: a company's products and
 * changes to them, claims on DRAP rows, a clinic's proposals to the national
 * catalog, and a company's announcements. Nothing a doctor sees changes
 * before that, and an approved announcement is only a draft until
 * RxDictate's console publishes it.
 *
 * Each type has one handler, below, that knows what may be sent and what
 * approving it does. The queue itself - who sees what, the history, the
 * statuses - knows nothing about medicines or announcements.
 */

/* ------------------------------------------------------------------ *
 * Reading and writing the queue
 * ------------------------------------------------------------------ */

// A sender's reads go through the scoped repository like any tenant's data.
const senders = new BaseRepository<ISubmission>(Submission, { softDelete: false });

/** Open: still the sender's or the reviewer's to act on. */
const OPEN: SubmissionStatus[] = ['pending', 'changesRequested'];

const REVIEW_STEPS: SubmissionStep[] = ['approved', 'rejected', 'changesRequested'];

const wrongStatus = (submission: SubmissionDoc, wanted: string): AppError =>
  new AppError('SUBMISSION_WRONG_STATUS', `This submission is ${submission.status}; ${wanted}.`, {
    status: submission.status,
  });

const asObjectId = (id: string, what: string): Types.ObjectId => {
  if (!Types.ObjectId.isValid(id)) {
    throw AppError.notFound(what);
  }
  return new Types.ObjectId(id);
};

/** Who is looking: the platform sees everyone's, a sender only its own. */
export interface Viewer {
  scope: Audited;
  organisationType: OrganisationType;
}

const isReviewer = (viewer: Viewer): boolean => viewer.organisationType === 'platform';

type Subject = SubmissionView['subject'];

const subjectOf = (brand: unknown, strength: unknown): Subject =>
  typeof brand === 'string' && brand
    ? { brand, strength: typeof strength === 'string' && strength ? strength : null }
    : null;

/**
 * What it is about, for a list row: a new product by its payload, anything
 * else by the row it names as that row is now. Null when that row is gone.
 */
const subjectFor = (submission: SubmissionDoc, drugs: Map<string, DrugDoc>): Subject => {
  if (submission.type === 'drug.create') {
    return subjectOf(submission.payload?.brand, submission.payload?.strength);
  }
  const drug = submission.drugId ? drugs.get(String(submission.drugId)) : undefined;
  return drug ? subjectOf(drug.brand, drug.strength) : null;
};

const toView = (
  submission: SubmissionDoc,
  organisation: PracticeDoc | undefined,
  subject: Subject,
  forReviewer: boolean,
): SubmissionView => ({
  id: String(submission._id),
  type: submission.type,
  status: submission.status,
  payload: submission.payload ?? {},
  subject,
  organisation: {
    id: String(submission.practiceId),
    name: organisation?.name ?? '',
    type: organisation?.type ?? 'company',
    status: organisation?.status ?? 'active',
  },
  submittedBy: String(submission.submittedBy),
  drugId: submission.drugId ? String(submission.drugId) : null,
  uploadId: submission.uploadId,
  note: submission.note,
  reviewerId: forReviewer && submission.reviewerId ? String(submission.reviewerId) : null,
  duplicateOfId: submission.duplicateOfId ? String(submission.duplicateOfId) : null,
  resultDrugId: submission.resultDrugId ? String(submission.resultDrugId) : null,
  resultAnnouncementId: submission.resultAnnouncementId ? String(submission.resultAnnouncementId) : null,
  history: submission.history.map((entry) => ({
    step: entry.step,
    at: entry.at,
    // Who reviewed is the platform's business; a sender sees only their own people.
    by: forReviewer || !REVIEW_STEPS.includes(entry.step) ? String(entry.by) : null,
    note: entry.note,
  })),
  submittedAt: submission.submittedAt,
  createdAt: submission.createdAt,
  updatedAt: submission.updatedAt,
});

/** Views of a page of submissions: one query for their organisations and one for the rows they name. */
const viewsOf = async (found: SubmissionDoc[], forReviewer: boolean): Promise<SubmissionView[]> => {
  const drugIds = [
    ...new Set(found.flatMap((row) => (row.type !== 'drug.create' && row.drugId ? [String(row.drugId)] : []))),
  ];
  const [organisations, drugs] = await Promise.all([
    Practice.find({ _id: { $in: [...new Set(found.map((row) => String(row.practiceId)))] } }),
    drugIds.length > 0 ? Drug.find({ _id: { $in: drugIds } }).select('brand strength') : Promise.resolve([]),
  ]);
  const byId = new Map(organisations.map((organisation) => [String(organisation._id), organisation]));
  const drugsById = new Map(drugs.map((drug) => [String(drug._id), drug]));
  return found.map((row) => toView(row, byId.get(String(row.practiceId)), subjectFor(row, drugsById), forReviewer));
};

const viewOf = async (submission: SubmissionDoc, forReviewer: boolean): Promise<SubmissionView> =>
  (await viewsOf([submission], forReviewer))[0];

const announce = (submission: SubmissionDoc, actorId: Types.ObjectId): void => {
  emit('submission.changed', {
    submissionId: submission._id,
    practiceId: submission.practiceId,
    type: submission.type,
    status: submission.status,
    drugId: submission.drugId,
    actorId,
  });
};

/** One submission this viewer may see, or NOT_FOUND: another organisation's is not theirs to know about. */
const findFor = async (viewer: Viewer, id: string): Promise<SubmissionDoc> => {
  const submissionId = asObjectId(id, 'Submission');
  const found = isReviewer(viewer)
    ? await Submission.findById(submissionId)
    : await senders.findById(viewer.scope, submissionId);
  if (!found) {
    throw AppError.notFound('Submission');
  }
  return found;
};

/** Open submissions of these types about this row from this organisation, apart from one. */
const openAbout = async (
  practiceId: Types.ObjectId,
  types: SubmissionType[],
  where: FilterQuery<ISubmission>,
  except?: Types.ObjectId,
): Promise<boolean> =>
  (await Submission.exists({
    practiceId,
    type: { $in: types },
    status: { $in: OPEN },
    ...where,
    ...(except ? { _id: { $ne: except } } : {}),
  })) !== null;

/* ------------------------------------------------------------------ *
 * What may be sent, type by type
 * ------------------------------------------------------------------ */

interface Prepared {
  payload: Record<string, unknown>;
  drugId: Types.ObjectId | null;
}

/** A national row this company owns, or NOT_FOUND: another company's is not theirs to know about. */
const ownedProduct = async (companyId: Types.ObjectId, drugId: Types.ObjectId | string): Promise<DrugDoc> => {
  const drug = Types.ObjectId.isValid(String(drugId))
    ? await Drug.findOne({ _id: drugId, ...nationalRows, companyId })
    : null;
  if (!drug) {
    throw AppError.notFound('Product');
  }
  return drug;
};

/** Whether a registration number is free for a new product, and if not, why. */
const assertRegistrationFree = async (
  companyId: Types.ObjectId,
  registrationNo: string,
  except?: Types.ObjectId,
): Promise<void> => {
  const existing = await Drug.findOne({ drapRegNo: registrationNo });
  if (existing) {
    if (existing.companyId?.equals(companyId)) {
      throw new AppError('CONFLICT', 'That registration number is already one of your products. Change it instead.', {
        drugId: String(existing._id),
      });
    }
    if (existing.companyId) {
      throw new AppError('CONFLICT', 'That registration number belongs to another company.');
    }
    throw new AppError('CONFLICT', 'That registration number is already in the catalog. Claim it instead.', {
      drugId: String(existing._id),
      claimable: true,
    });
  }
  if (await openAbout(companyId, ['drug.create', 'drug.claim'], { 'payload.registrationNo': registrationNo }, except)) {
    throw new AppError('CONFLICT', 'A product with that registration number is already waiting for review.');
  }
};

const prepareCreate = async (
  companyId: Types.ObjectId,
  fields: ProductFields,
  except?: Types.ObjectId,
): Promise<Prepared> => {
  await assertRegistrationFree(companyId, fields.registrationNo, except);
  return { payload: { ...fields }, drugId: null };
};

/** A change, as the company's product would read with it. Nothing that already says this. */
const changesFrom = (drug: DrugDoc, changes: UpdateProductBody): UpdateProductBody => {
  const live: Record<keyof UpdateProductBody, string> = {
    brand: drug.brand,
    composition: drug.generic,
    strength: drug.strength,
    form: drug.form,
    pack: drug.pack,
  };
  return Object.fromEntries(
    Object.entries(changes).filter(
      ([field, value]) => value !== undefined && live[field as keyof UpdateProductBody] !== value,
    ),
  ) as UpdateProductBody;
};

const prepareUpdate = async (
  companyId: Types.ObjectId,
  drugId: Types.ObjectId | string,
  changes: UpdateProductBody,
  except?: Types.ObjectId,
): Promise<Prepared> => {
  const drug = await ownedProduct(companyId, drugId);
  if (await openAbout(companyId, ['drug.update', 'drug.discontinue'], { drugId: drug._id }, except)) {
    throw new AppError('CONFLICT', 'A change to this product is already waiting for review.');
  }
  const changed = changesFrom(drug, changes);
  if (Object.keys(changed).length === 0) {
    throw new AppError('VALIDATION_ERROR', 'body: that is what the product already says', [
      { field: 'body', message: 'nothing to change' },
    ]);
  }
  return { payload: changed, drugId: drug._id };
};

const prepareDiscontinue = async (
  companyId: Types.ObjectId,
  drugId: Types.ObjectId | string,
  except?: Types.ObjectId,
): Promise<Prepared> => {
  const drug = await ownedProduct(companyId, drugId);
  if (drug.status !== 'active') {
    throw new AppError('CONFLICT', 'This product is already discontinued.');
  }
  if (await openAbout(companyId, ['drug.update', 'drug.discontinue'], { drugId: drug._id }, except)) {
    throw new AppError('CONFLICT', 'A change to this product is already waiting for review.');
  }
  return { payload: {}, drugId: drug._id };
};

const prepareClaim = async (
  companyId: Types.ObjectId,
  body: ClaimProductBody,
  except?: Types.ObjectId,
): Promise<Prepared> => {
  const drug = await Drug.findOne({ ...nationalRows, drapRegNo: body.registrationNo });
  if (!drug) {
    throw new AppError('NOT_FOUND', 'No product in the catalog has that registration number.');
  }
  if (drug.companyId?.equals(companyId)) {
    throw new AppError('CONFLICT', 'That product is already yours.');
  }
  if (drug.companyId) {
    throw new AppError('CONFLICT', 'That product already belongs to another company.');
  }
  if (await openAbout(companyId, ['drug.claim'], { drugId: drug._id }, except)) {
    throw new AppError('CONFLICT', 'Your claim on that product is already waiting for review.');
  }
  return { payload: { registrationNo: body.registrationNo }, drugId: drug._id };
};

/** A clinic's own active item, as it stands now. */
const preparePropose = async (
  clinicId: Types.ObjectId,
  drugId: Types.ObjectId | string,
  except?: Types.ObjectId,
): Promise<Prepared> => {
  const drug = Types.ObjectId.isValid(String(drugId))
    ? await Drug.findOne({ _id: drugId, scope: 'clinic', practiceId: clinicId, ownerId: null })
    : null;
  if (!drug) {
    throw new AppError('NOT_FOUND', "Medicine not found among this clinic's own items.");
  }
  if (drug.status !== 'active') {
    throw new AppError('CONFLICT', 'This item has been discontinued.');
  }
  if (await openAbout(clinicId, ['drug.propose'], { drugId: drug._id }, except)) {
    throw new AppError('CONFLICT', 'This item has already been proposed and is waiting for review.');
  }
  const payload: ProposalPayload = {
    brand: drug.brand,
    generic: drug.generic,
    strength: drug.strength,
    form: drug.form,
    pack: drug.pack,
    company: drug.company,
  };
  return { payload, drugId: drug._id };
};

/* ------------------------------------------------------------------ *
 * What approving does, type by type
 * ------------------------------------------------------------------ */

interface Approval {
  scope: Audited;
  submission: SubmissionDoc;
  sender: PracticeDoc;
  body: ApproveSubmissionBody;
}

const auditDrug = async (scope: Audited, action: string, drugId: Types.ObjectId, before: unknown, after: unknown) =>
  writeAudit(scope, { action, entity: 'drug', entityId: drugId, before, after, requestId: scope.requestId ?? null });

/** It has changed under the submission since it was sent; the reviewer should ask again. */
const goneStale = (what: string): AppError => new AppError('CONFLICT', `${what} Ask the sender for changes, or reject it.`);

const productFields = (fields: Partial<ProductFields> & UpdateProductBody): Partial<IDrug> => {
  const mapped: Partial<IDrug> = {};
  if (fields.brand !== undefined) mapped.brand = fields.brand;
  if (fields.composition !== undefined) mapped.generic = fields.composition;
  if (fields.strength !== undefined) mapped.strength = fields.strength;
  if (fields.form !== undefined) mapped.form = fields.form;
  if (fields.pack !== undefined) mapped.pack = fields.pack;
  return mapped;
};

/** A national, active row the company owns, with the company's name on it. */
const approveCreate = async ({ scope, submission, sender }: Approval): Promise<Types.ObjectId> => {
  const fields = SUBMISSION_PAYLOAD_SCHEMAS['drug.create'].parse(submission.payload);
  const existing = await Drug.findOne({ drapRegNo: fields.registrationNo });
  if (existing) {
    throw new AppError(
      'CONFLICT',
      'That registration number is in the catalog now. Reject this as a duplicate of it, so the company can claim it.',
      { drugId: String(existing._id) },
    );
  }
  const row = {
    brand: fields.brand,
    generic: fields.composition,
    strength: fields.strength,
    form: fields.form,
    pack: fields.pack,
    company: sender.name,
  };
  const drug = await Drug.create({
    ...row,
    ...drugKeys(row),
    aliases: [],
    drapRegNo: fields.registrationNo,
    source: 'company',
    scope: 'national',
    status: 'active',
    practiceId: null,
    ownerId: null,
    companyId: sender._id,
    createdBy: submission.submittedBy,
  });
  await auditDrug(scope, 'drug.create', drug._id, null, { ...toDrugView(drug), submissionId: String(submission._id) });
  return drug._id;
};

/** The live row changes now, and not before. */
const approveUpdate = async ({ scope, submission, sender }: Approval): Promise<Types.ObjectId> => {
  const changes = SUBMISSION_PAYLOAD_SCHEMAS['drug.update'].parse(submission.payload);
  const drug = await Drug.findOne({ _id: submission.drugId, ...nationalRows, companyId: sender._id });
  if (!drug) {
    throw goneStale('This product no longer belongs to the company.');
  }
  const before = toDrugView(drug);
  drug.set(productFields(changes));
  drug.set(drugKeys(drug));
  await drug.save();
  await auditDrug(scope, 'drug.update', drug._id, before, { ...toDrugView(drug), submissionId: String(submission._id) });
  return drug._id;
};

/** Discontinued, and still on every list marked so, as any discontinued row is. */
const approveDiscontinue = async ({ scope, submission, sender }: Approval): Promise<Types.ObjectId> => {
  const drug = await Drug.findOne({ _id: submission.drugId, ...nationalRows, companyId: sender._id });
  if (!drug) {
    throw goneStale('This product no longer belongs to the company.');
  }
  const before = toDrugView(drug);
  drug.status = 'discontinued';
  await drug.save();
  await auditDrug(scope, 'drug.discontinue', drug._id, before, {
    ...toDrugView(drug),
    submissionId: String(submission._id),
  });
  return drug._id;
};

/** The company owns the DRAP row from now on. Its id, and so every list and all usage, stay as they are. */
const approveClaim = async ({ scope, submission, sender }: Approval): Promise<Types.ObjectId> => {
  const drug = await Drug.findOne({ _id: submission.drugId, ...nationalRows });
  if (!drug) {
    throw goneStale('That product is no longer in the catalog.');
  }
  if (drug.companyId && !drug.companyId.equals(sender._id)) {
    throw goneStale('That product has been claimed by another company since.');
  }
  const before = toDrugView(drug);
  drug.companyId = sender._id;
  drug.company = sender.name;
  drug.source = 'company';
  await drug.save();
  await auditDrug(scope, 'drug.claim', drug._id, before, { ...toDrugView(drug), submissionId: String(submission._id) });
  return drug._id;
};

/**
 * Move one clinic's lists and usage from a retired row to the row it went
 * into. A list that already has that row keeps its own entry for it; usage
 * adds up, with the later of the two last uses.
 */
const moveIntoRow = async (
  clinicId: Types.ObjectId,
  from: Types.ObjectId,
  into: Types.ObjectId,
): Promise<{ lists: number; usage: number }> => {
  const lists = await DrugList.find({ practiceId: clinicId, 'items.drugId': from });
  await Promise.all(
    lists.map(async (list) => {
      const hasTarget = list.items.some((item) => item.drugId.equals(into));
      await (hasTarget
        ? DrugList.updateOne({ _id: list._id }, { $pull: { items: { drugId: from } } })
        : DrugList.updateOne({ _id: list._id, 'items.drugId': from }, { $set: { 'items.$.drugId': into } }));
    }),
  );

  const usage = await DrugUsage.find({ practiceId: clinicId, drugId: from });
  await Promise.all(
    usage.map(async (row) => {
      await DrugUsage.updateOne(
        { practiceId: clinicId, doctorId: row.doctorId, drugId: into },
        { $inc: { count: row.count }, $max: { lastUsedAt: row.lastUsedAt } },
        { upsert: true },
      );
      await DrugUsage.deleteOne({ _id: row._id });
    }),
  );

  return { lists: lists.length, usage: usage.length };
};

/**
 * Publish: the clinic's row becomes national with the same id, so every list
 * holding it keeps it. Merge: its list items and usage move to an existing
 * national row and it is retired, pointing at that row. Prescriptions never
 * change either way; they keep their own copy of each line.
 */
const approvePropose = async ({ scope, submission, sender, body }: Approval): Promise<Types.ObjectId> => {
  if (!body.decision) {
    throw new AppError(
      'VALIDATION_ERROR',
      'body.decision: say whether to publish this item or merge it into a national one',
      [{ field: 'body.decision', message: 'is needed for a proposal: publish or merge' }],
    );
  }
  const drug = await Drug.findOne({ _id: submission.drugId, scope: 'clinic', practiceId: sender._id, ownerId: null });
  if (!drug || drug.status !== 'active') {
    throw goneStale("This item is no longer one of the clinic's active items.");
  }
  const before = toDrugView(drug);
  const clinicScope: Scope = { practiceId: sender._id, actorId: scope.actorId, role: scope.role, allowedLocationIds: [] };

  if (body.decision === 'publish') {
    drug.scope = 'national';
    drug.practiceId = null;
    drug.ownerId = null;
    await drug.save();
    await auditDrug(scope, 'drug.publish', drug._id, before, { ...toDrugView(drug), submissionId: String(submission._id) });
    announceMedicines(clinicScope, 'clinic', drug._id);
    return drug._id;
  }

  const into =
    body.intoDrugId && Types.ObjectId.isValid(body.intoDrugId)
      ? await Drug.findOne({ _id: body.intoDrugId, ...nationalRows, status: 'active' })
      : null;
  if (!into) {
    throw new AppError('VALIDATION_ERROR', 'body.intoDrugId: must be an active medicine in the national catalog', [
      { field: 'body.intoDrugId', message: 'must be an active medicine in the national catalog' },
    ]);
  }

  const moved = await moveIntoRow(sender._id, drug._id, into._id);
  drug.status = 'discontinued';
  drug.mergedIntoId = into._id;
  await drug.save();
  await auditDrug(scope, 'drug.merge', drug._id, before, {
    ...toDrugView(drug),
    mergedIntoId: String(into._id),
    listsMoved: moved.lists,
    usageMoved: moved.usage,
    submissionId: String(submission._id),
  });
  announceMedicines(clinicScope, 'clinic', drug._id);
  announceMedicines(clinicScope, 'clinic', into._id);
  return into._id;
};

/** A draft in RxDictate's console, with the company as sponsor, linked both ways. Published there, not here. */
const approveAnnouncement = async ({ scope, submission }: Approval): Promise<Approved> => {
  const payload = SUBMISSION_PAYLOAD_SCHEMAS['announcement.create'].parse(submission.payload);
  const announcement = await createFromSubmission(scope, submission, payload);
  return { resultDrugId: null, resultAnnouncementId: announcement._id };
};

/* ------------------------------------------------------------------ *
 * The handlers
 * ------------------------------------------------------------------ */

/** What approving made or changed: a national row, or an announcement's draft. */
interface Approved {
  resultDrugId: Types.ObjectId | null;
  resultAnnouncementId: Types.ObjectId | null;
}

/** A medicine's approval, which answers the row it made or changed. */
const drugResult =
  (approveDrug: (approval: Approval) => Promise<Types.ObjectId>) =>
  async (approval: Approval): Promise<Approved> => ({
    resultDrugId: await approveDrug(approval),
    resultAnnouncementId: null,
  });

interface Handler {
  /** Check a resubmission as if it were sent fresh, apart from this submission itself. */
  resubmit(submission: SubmissionDoc, payload: Record<string, unknown> | undefined): Promise<Prepared>;
  approve(approval: Approval): Promise<Approved>;
  /** The brand, strength, form and registration number a reviewer looks for duplicates of. */
  identity(
    submission: SubmissionDoc,
    current: DrugDoc | null,
  ): { registrationNo: string | null; identityKey: string } | null;
}

/** A payload sent again, checked against its type's schema. */
const parsed = <S extends ZodType>(schema: S, payload: unknown): z.infer<S> => {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      result.error.issues.map((issue) => `body.payload.${issue.path.join('.')}: ${issue.message}`).join(', '),
      result.error.issues.map((issue) => ({
        field: ['body', 'payload', ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data as z.infer<S>;
};

const HANDLERS: Record<SubmissionType, Handler> = {
  'drug.create': {
    resubmit: (submission, payload) =>
      prepareCreate(
        submission.practiceId,
        parsed(SUBMISSION_PAYLOAD_SCHEMAS['drug.create'], payload ?? submission.payload),
        submission._id,
      ),
    approve: drugResult(approveCreate),
    identity: (submission) => {
      const fields = SUBMISSION_PAYLOAD_SCHEMAS['drug.create'].parse(submission.payload);
      return { registrationNo: fields.registrationNo, identityKey: identityKeyOf(fields) };
    },
  },
  'drug.update': {
    resubmit: (submission, payload) =>
      prepareUpdate(
        submission.practiceId,
        submission.drugId!,
        parsed(SUBMISSION_PAYLOAD_SCHEMAS['drug.update'], payload ?? submission.payload),
        submission._id,
      ),
    approve: drugResult(approveUpdate),
    identity: (submission, current) => {
      if (!current) return null;
      const changes = SUBMISSION_PAYLOAD_SCHEMAS['drug.update'].parse(submission.payload);
      return {
        registrationNo: current.drapRegNo,
        identityKey: identityKeyOf({
          brand: changes.brand ?? current.brand,
          strength: changes.strength ?? current.strength,
          form: changes.form ?? current.form,
        }),
      };
    },
  },
  'drug.discontinue': {
    resubmit: (submission) => prepareDiscontinue(submission.practiceId, submission.drugId!, submission._id),
    approve: drugResult(approveDiscontinue),
    identity: () => null,
  },
  'drug.claim': {
    resubmit: (submission, payload) =>
      prepareClaim(
        submission.practiceId,
        parsed(SUBMISSION_PAYLOAD_SCHEMAS['drug.claim'], payload ?? submission.payload),
        submission._id,
      ),
    approve: drugResult(approveClaim),
    identity: (_submission, current) =>
      current ? { registrationNo: current.drapRegNo, identityKey: current.identityKey } : null,
  },
  'drug.propose': {
    // Sent again as the item now stands: the clinic corrects the item itself, not the proposal.
    resubmit: (submission) => preparePropose(submission.practiceId, submission.drugId!, submission._id),
    approve: drugResult(approvePropose),
    identity: (submission) => {
      const fields = SUBMISSION_PAYLOAD_SCHEMAS['drug.propose'].parse(submission.payload);
      return { registrationNo: null, identityKey: identityKeyOf(fields) };
    },
  },
  'announcement.create': {
    resubmit: (submission, payload) =>
      preparePayload(
        submission.practiceId,
        parsed(SUBMISSION_PAYLOAD_SCHEMAS['announcement.create'], payload ?? submission.payload),
        'body.payload',
      ),
    approve: approveAnnouncement,
    // An announcement has no duplicates to look for.
    identity: () => null,
  },
};

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

const send = async (
  scope: Audited,
  type: SubmissionType,
  prepared: Prepared,
  uploadId: string | null = null,
): Promise<SubmissionDoc> => {
  const now = new Date();
  const submission = await senders.create(scope, {
    type,
    payload: prepared.payload,
    drugId: prepared.drugId,
    uploadId,
    submittedBy: scope.actorId,
    status: 'pending',
    queueRank: QUEUE_RANK.pending,
    submittedAt: now,
    history: [{ step: 'submitted', at: now, by: scope.actorId, note: null, payload: prepared.payload }],
  });
  await writeAudit(scope, {
    action: 'submission.create',
    entity: 'submission',
    entityId: submission._id,
    after: { type, payload: prepared.payload, drugId: prepared.drugId ? String(prepared.drugId) : null, uploadId },
    requestId: scope.requestId ?? null,
  });
  announce(submission, scope.actorId);
  return submission;
};

/** A company's new product. */
export const submitCreate = async (scope: Audited, fields: ProductFields, uploadId: string | null = null) =>
  send(scope, 'drug.create', await prepareCreate(scope.practiceId, fields), uploadId);

/** A change to one of the company's products. */
export const submitUpdate = async (
  scope: Audited,
  drugId: string,
  changes: UpdateProductBody,
  uploadId: string | null = null,
) => send(scope, 'drug.update', await prepareUpdate(scope.practiceId, drugId, changes), uploadId);

export const submitDiscontinue = async (scope: Audited, drugId: string) =>
  send(scope, 'drug.discontinue', await prepareDiscontinue(scope.practiceId, drugId));

export const submitClaim = async (scope: Audited, body: ClaimProductBody, uploadId: string | null = null) =>
  send(scope, 'drug.claim', await prepareClaim(scope.practiceId, body), uploadId);

/**
 * `POST /company/announcements`: the company's announcement and its wishes,
 * for review. Accepted whatever its allowance; only publishing is limited.
 */
export const submitAnnouncement = async (scope: Audited, payload: CompanyAnnouncementPayload): Promise<SubmissionView> =>
  viewOf(await send(scope, 'announcement.create', await preparePayload(scope.practiceId, payload, 'body')), false);

/** `POST /drugs/:id/propose`: a clinic's own item, offered to the national catalog. */
export const proposeDrug = async (scope: Audited, drugId: string): Promise<SubmissionView> =>
  viewOf(await send(scope, 'drug.propose', await preparePropose(scope.practiceId, drugId)), false);

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export const listSubmissions = async (
  viewer: Viewer,
  query: ListSubmissionsQuery,
): Promise<{ submissions: SubmissionView[]; meta: PageMeta }> => {
  const reviewer = isReviewer(viewer);
  const filter: FilterQuery<ISubmission> = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.uploadId ? { uploadId: query.uploadId } : {}),
    ...(reviewer && query.organisationId ? { practiceId: new Types.ObjectId(query.organisationId) } : {}),
  };
  const options = {
    page: query.page,
    limit: query.limit,
    sortBy: query.status ? 'submittedAt:asc,_id:asc' : 'queueRank:asc,submittedAt:asc,_id:asc',
  };
  const result = reviewer
    ? await Submission.paginate(filter, options)
    : await senders.paginate(viewer.scope, filter, options);
  return {
    submissions: await viewsOf(result.results, reviewer),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

/** National rows a reviewer should compare this with. Never shown to a sender. */
const duplicatesOf = async (submission: SubmissionDoc, current: DrugDoc | null): Promise<DrugDoc[]> => {
  const identity = HANDLERS[submission.type].identity(submission, current);
  if (!identity) {
    return [];
  }
  const either: FilterQuery<IDrug>[] = [{ identityKey: identity.identityKey, status: 'active' }];
  if (identity.registrationNo) {
    either.push({ drapRegNo: identity.registrationNo });
  }
  return Drug.find({
    ...nationalRows,
    ...(submission.drugId ? { _id: { $ne: submission.drugId } } : {}),
    $or: either,
  })
    .sort({ brandKey: 1, _id: 1 })
    .limit(20);
};

export const getSubmission = async (viewer: Viewer, id: string): Promise<SubmissionDetailView> => {
  const submission = await findFor(viewer, id);
  const reviewer = isReviewer(viewer);
  const current = submission.drugId ? await Drug.findById(submission.drugId) : null;
  return {
    submission: await viewOf(submission, reviewer),
    current: current ? toDrugView(current) : null,
    duplicates: reviewer ? (await duplicatesOf(submission, current)).map(toDrugView) : [],
    allowance: submission.type === 'announcement.create' ? await allowanceViewFor(submission.practiceId) : null,
  };
};

/* ------------------------------------------------------------------ *
 * The sender's own changes
 * ------------------------------------------------------------------ */

/**
 * `PATCH /submissions/:id`: send a `changesRequested` one again, as the same
 * submission. It is checked as if sent fresh, and goes back to the queue.
 */
export const resubmit = async (viewer: Viewer, id: string, body: ResubmitSubmissionBody): Promise<SubmissionView> => {
  const submission = await findFor(viewer, id);
  if (submission.status !== 'changesRequested') {
    throw wrongStatus(submission, 'only one sent back for changes can be sent again');
  }
  const prepared = await HANDLERS[submission.type].resubmit(submission, body.payload);

  const now = new Date();
  const updated = await Submission.findOneAndUpdate(
    { _id: submission._id, status: 'changesRequested' },
    {
      $set: {
        payload: prepared.payload,
        drugId: prepared.drugId,
        status: 'pending',
        queueRank: QUEUE_RANK.pending,
        submittedAt: now,
        note: null,
      },
      $push: { history: { step: 'resubmitted', at: now, by: viewer.scope.actorId, note: null, payload: prepared.payload } },
    },
    { new: true },
  );
  if (!updated) {
    throw wrongStatus(submission, 'it changed while you were editing it');
  }

  await writeAudit(viewer.scope, {
    action: 'submission.resubmit',
    entity: 'submission',
    entityId: updated._id,
    before: { payload: submission.payload, status: submission.status },
    after: { payload: updated.payload, status: updated.status },
    requestId: viewer.scope.requestId ?? null,
  });
  announce(updated, viewer.scope.actorId);
  return viewOf(updated, false);
};

/** `POST /submissions/:id/withdraw`: take back one that is still open. It can never be approved after. */
export const withdraw = async (viewer: Viewer, id: string): Promise<SubmissionView> => {
  const submission = await findFor(viewer, id);
  const updated = await Submission.findOneAndUpdate(
    { _id: submission._id, status: { $in: OPEN } },
    {
      $set: { status: 'withdrawn', queueRank: QUEUE_RANK.withdrawn },
      $push: { history: { step: 'withdrawn', at: new Date(), by: viewer.scope.actorId, note: null, payload: null } },
    },
    { new: true },
  );
  if (!updated) {
    throw wrongStatus(submission, 'only an open one can be withdrawn');
  }
  await writeAudit(viewer.scope, {
    action: 'submission.withdraw',
    entity: 'submission',
    entityId: updated._id,
    before: { status: submission.status },
    after: { status: updated.status },
    requestId: viewer.scope.requestId ?? null,
  });
  announce(updated, viewer.scope.actorId);
  return viewOf(updated, false);
};

/* ------------------------------------------------------------------ *
 * The reviewer's decisions
 * ------------------------------------------------------------------ */

/** A pending submission from an organisation that is not suspended, or why not. */
const decidable = async (id: string): Promise<{ submission: SubmissionDoc; sender: PracticeDoc }> => {
  const submission = await Submission.findById(asObjectId(id, 'Submission'));
  if (!submission) {
    throw AppError.notFound('Submission');
  }
  if (submission.status !== 'pending') {
    throw wrongStatus(submission, 'only a pending one can be decided');
  }
  const sender = await Practice.findById(submission.practiceId);
  if (!sender) {
    throw AppError.notFound('Organisation');
  }
  if (sender.status === 'suspended') {
    throw new AppError(
      'ORGANISATION_SUSPENDED',
      `${sender.name} is suspended. Its submissions wait until it is reactivated.`,
    );
  }
  return { submission, sender };
};

/**
 * Move a pending submission on, once: two reviewers deciding at the same
 * moment end with one decision. Answers null when it was no longer pending.
 */
const decide = async (
  submission: SubmissionDoc,
  scope: Audited,
  step: Extract<SubmissionStep, 'approved' | 'rejected' | 'changesRequested'>,
  note: string | null,
  extra: Partial<Pick<ISubmission, 'duplicateOfId'>> = {},
): Promise<SubmissionDoc | null> =>
  Submission.findOneAndUpdate(
    { _id: submission._id, status: 'pending' },
    {
      $set: { status: step, queueRank: QUEUE_RANK[step], reviewerId: scope.actorId, note, ...extra },
      $push: { history: { step, at: new Date(), by: scope.actorId, note, payload: null } },
    },
    { new: true },
  );

const recordDecision = async (
  scope: Audited,
  before: SubmissionDoc,
  after: SubmissionDoc,
  action: string,
): Promise<SubmissionView> => {
  await writeAudit(scope, {
    action,
    entity: 'submission',
    entityId: after._id,
    before: { status: before.status },
    after: {
      status: after.status,
      note: after.note,
      resultDrugId: after.resultDrugId ? String(after.resultDrugId) : null,
      resultAnnouncementId: after.resultAnnouncementId ? String(after.resultAnnouncementId) : null,
      duplicateOfId: after.duplicateOfId ? String(after.duplicateOfId) : null,
    },
    requestId: scope.requestId ?? null,
  });
  announce(after, scope.actorId);
  return viewOf(after, true);
};

/**
 * `POST /submissions/:id/approve`: claimed for this reviewer first, so it is
 * done once, then carried out by its type's handler. If carrying it out fails,
 * it goes back to pending as it was.
 */
export const approve = async (scope: Audited, id: string, body: ApproveSubmissionBody): Promise<SubmissionView> => {
  const { submission, sender } = await decidable(id);
  if (submission.type !== 'drug.propose' && (body.decision || body.intoDrugId)) {
    throw new AppError('VALIDATION_ERROR', 'body.decision: only a proposal is published or merged', [
      { field: 'body.decision', message: 'is only for a proposal' },
    ]);
  }

  const claimed = await decide(submission, scope, 'approved', body.note ?? null);
  if (!claimed) {
    throw wrongStatus(submission, 'it was decided while you were looking at it');
  }

  let approved: Approved;
  try {
    approved = await HANDLERS[submission.type].approve({ scope, submission: claimed, sender, body });
  } catch (error) {
    await Submission.updateOne(
      { _id: submission._id },
      {
        $set: { status: 'pending', queueRank: QUEUE_RANK.pending, reviewerId: submission.reviewerId, note: submission.note },
        $pop: { history: 1 },
      },
    );
    throw error;
  }

  claimed.resultDrugId = approved.resultDrugId;
  claimed.resultAnnouncementId = approved.resultAnnouncementId;
  await claimed.save();
  return recordDecision(scope, submission, claimed, 'submission.approve');
};

/** `POST /submissions/:id/reject`: final, with a note the sender reads. */
export const reject = async (scope: Audited, id: string, body: RejectSubmissionBody): Promise<SubmissionView> => {
  const { submission } = await decidable(id);
  let duplicateOfId: Types.ObjectId | null = null;
  if (body.duplicateOfId) {
    if (submission.type !== 'drug.create') {
      throw new AppError('VALIDATION_ERROR', 'body.duplicateOfId: only a new product can be a duplicate', [
        { field: 'body.duplicateOfId', message: 'is only for a new product' },
      ]);
    }
    const duplicate = await Drug.findOne({ _id: body.duplicateOfId, ...nationalRows });
    if (!duplicate) {
      throw new AppError('VALIDATION_ERROR', 'body.duplicateOfId: must be a medicine in the national catalog', [
        { field: 'body.duplicateOfId', message: 'must be a medicine in the national catalog' },
      ]);
    }
    duplicateOfId = duplicate._id;
  }

  const updated = await decide(submission, scope, 'rejected', body.note, { duplicateOfId });
  if (!updated) {
    throw wrongStatus(submission, 'it was decided while you were looking at it');
  }
  return recordDecision(scope, submission, updated, 'submission.reject');
};

/** `POST /submissions/:id/request-changes`: back to the sender with a note, to edit and send again. */
export const requestChanges = async (scope: Audited, id: string, body: RequestChangesBody): Promise<SubmissionView> => {
  const { submission } = await decidable(id);
  const updated = await decide(submission, scope, 'changesRequested', body.note);
  if (!updated) {
    throw wrongStatus(submission, 'it was decided while you were looking at it');
  }
  return recordDecision(scope, submission, updated, 'submission.requestChanges');
};

export default {
  submitCreate,
  submitUpdate,
  submitDiscontinue,
  submitClaim,
  submitAnnouncement,
  proposeDrug,
  listSubmissions,
  getSubmission,
  resubmit,
  withdraw,
  approve,
  reject,
  requestChanges,
};
