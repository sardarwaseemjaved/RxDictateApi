import type { Types } from 'mongoose';
import { Prescription, Template, type ITemplate, type TemplateDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import type { PrescriptionSections } from '../shared/prescription.schema';
import {
  templateViewSchema,
  type CreateTemplateBody,
  type ListTemplatesQuery,
  type TemplateView,
  type UpdateTemplateBody,
} from '../shared/template.schema';
import type { PageMeta } from '../shared/response';
import { escapeRegex } from '../utils/regex';
import { isEmpty, wireSections } from './prescriptionOps.service';

const templates = new BaseRepository<ITemplate>(Template);

/** Parsed through the contract, as a prescription is, so the two cannot drift. */
export const toTemplateView = (template: TemplateDoc): TemplateView =>
  templateViewSchema.parse({
    id: String(template._id),
    name: template.name,
    sections: wireSections(template.sections),
    useCount: template.useCount,
    lastUsedAt: template.lastUsedAt,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  });

const withoutSpans = <T extends { sourceSpanIds: string[] }>(items: T[]): T[] =>
  items.map((item) => ({ ...item, sourceSpanIds: [] }));

/**
 * What a template keeps of a set of sections.
 *
 * The follow-up's date is about one patient and is dropped; its interval is
 * the habit and is kept. Flags, `correctedBySpeech` and source spans describe
 * one dictation, not the regimen - and a flag carried into a template would
 * block approval of every prescription started from it.
 *
 * Spelled out section by section, so a section added to the contract is a type
 * error here until somebody decides what a template keeps of it.
 */
export const templateSections = (sections: unknown): PrescriptionSections => {
  const wire = wireSections(sections);
  return {
    complaints: withoutSpans(wire.complaints),
    history: withoutSpans(wire.history),
    examination: withoutSpans(wire.examination),
    diagnosis: withoutSpans(wire.diagnosis),
    medicines: withoutSpans(wire.medicines).map((medicine) => ({ ...medicine, flags: [], correctedBySpeech: false })),
    labs: withoutSpans(wire.labs),
    dietEat: withoutSpans(wire.dietEat),
    dietAvoid: withoutSpans(wire.dietAvoid),
    advice: withoutSpans(wire.advice),
    followUp: { ...wire.followUp, date: null },
  };
};

const assertNotEmpty = (sections: PrescriptionSections): void => {
  if (isEmpty(sections)) {
    throw new AppError('VALIDATION_ERROR', 'A template needs at least one line.');
  }
};

/**
 * One name per doctor, in any case. Two templates both called "Hypertension"
 * are a list nobody can choose from, and a name is what "use the hypertension
 * template" will be matched on once that can be dictated.
 */
const assertNameFree = async (scope: Scope, name: string, except?: Types.ObjectId): Promise<void> => {
  const clash = await templates.findOne(scope, {
    doctorId: scope.actorId,
    name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    ...(except ? { _id: { $ne: except } } : {}),
  });
  if (clash) {
    throw new AppError('CONFLICT', `You already have a template called "${clash.name}".`);
  }
};

/**
 * One of this doctor's templates. Another doctor's, in this clinic or any
 * other, is a 404 like anything else that is not the caller's to see.
 */
export const findOwnTemplate = async (scope: Scope, id: string): Promise<TemplateDoc> => {
  const template = await templates.findOne(scope, { _id: id, doctorId: scope.actorId });
  if (!template) {
    throw AppError.notFound('Template');
  }
  return template;
};

export const listTemplates = async (
  scope: Scope,
  query: ListTemplatesQuery,
): Promise<{ templates: TemplateView[]; meta: PageMeta }> => {
  const result = await templates.paginate(
    scope,
    {
      doctorId: scope.actorId,
      // A string regex, escaped, so whatever was typed is matched literally.
      ...(query.q ? { name: { $regex: escapeRegex(query.q), $options: 'i' } } : {}),
    },
    { page: query.page, limit: query.limit, sortBy: 'useCount:desc,name:asc' },
  );

  return {
    templates: result.results.map(toTemplateView),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

export const getTemplate = async (scope: Scope, id: string): Promise<TemplateView> =>
  toTemplateView(await findOwnTemplate(scope, id));

/**
 * From sections, or "Save as template" from an approved prescription.
 *
 * Saving from a prescription leaves its complaints, history and examination
 * behind: those describe the patient it was written for, and copied into a
 * template they would turn up on the next patient's page.
 */
export const createTemplate = async (scope: Scope, body: CreateTemplateBody): Promise<TemplateView> => {
  let source: unknown = body.sections;

  if (body.fromPrescriptionId) {
    const prescription = await Prescription.findOne({
      _id: body.fromPrescriptionId,
      practiceId: scope.practiceId,
      deletedAt: null,
    });
    if (!prescription) {
      throw AppError.notFound('Prescription');
    }
    if (prescription.status !== 'approved') {
      throw new AppError('RX_NOT_APPROVED', 'Only an approved prescription can be saved as a template.');
    }
    source = { ...wireSections(prescription.sections), complaints: [], history: [], examination: [] };
  }

  const sections = templateSections(source);
  assertNotEmpty(sections);
  await assertNameFree(scope, body.name);

  const template = await templates.create(scope, {
    doctorId: scope.actorId,
    name: body.name,
    sections,
    useCount: 0,
    lastUsedAt: null,
  });

  const after = toTemplateView(template);
  await writeAudit(scope, {
    action: 'template.create',
    entity: 'template',
    entityId: template._id,
    after: { ...after, fromPrescriptionId: body.fromPrescriptionId ?? null },
  });

  return after;
};

/** `sections`, when sent, replaces the template's sections whole. */
export const updateTemplate = async (scope: Scope, id: string, body: UpdateTemplateBody): Promise<TemplateView> => {
  const template = await findOwnTemplate(scope, id);
  const before = toTemplateView(template);

  if (body.name !== undefined && body.name !== template.name) {
    await assertNameFree(scope, body.name, template._id);
    template.name = body.name;
  }

  if (body.sections !== undefined) {
    const sections = templateSections(body.sections);
    assertNotEmpty(sections);
    template.set('sections', sections);
    // Mixed, so mongoose has to be told the value changed.
    template.markModified('sections');
  }

  await template.save();

  const after = toTemplateView(template);
  await writeAudit(scope, { action: 'template.update', entity: 'template', entityId: template._id, before, after });
  return after;
};

/**
 * Soft, like everything else: the audit entries of the prescriptions started
 * from it still name it, and should still lead somewhere.
 */
export const deleteTemplate = async (scope: Scope, id: string): Promise<TemplateView> => {
  const template = await findOwnTemplate(scope, id);
  const before = toTemplateView(template);

  await templates.softDeleteById(scope, template._id);

  await writeAudit(scope, { action: 'template.delete', entity: 'template', entityId: template._id, before });
  return before;
};

/**
 * Count a use. `timestamps: false`, so updatedAt keeps meaning "last edited"
 * rather than moving every time the template is applied.
 */
export const markTemplateUsed = async (scope: Scope, template: TemplateDoc): Promise<void> => {
  await Template.updateOne(
    { _id: template._id, practiceId: scope.practiceId },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } },
    { timestamps: false },
  );
};

export default {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  findOwnTemplate,
  markTemplateUsed,
  templateSections,
  toTemplateView,
};
