import { Types } from 'mongoose';
import { Practice, type PracticeDoc } from '../models';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { Scope } from '../core/db';
import type { PageMeta } from '../shared/response';
import type { CompanyView, CreateCompanyBody, ListCompaniesQuery, UpdateCompanyBody } from '../shared/company.schema';
import { grantMembership } from './team.service';

type Audited = Scope & { requestId?: string | null };

/**
 * Medicine companies, made and looked after by RxDictate.
 *
 * A company is an organisation of type `company` in the same collection as
 * clinics. RxDictate checks who a company is - its SECP registration and DRAP
 * licence - before it exists, because its products reach every doctor, so
 * only the platform makes one. Its admin then adds its own staff.
 */

export const toCompanyView = (company: PracticeDoc): CompanyView => ({
  id: String(company._id),
  name: company.name,
  address: company.address ?? '',
  province: company.province ?? null,
  city: company.city ?? null,
  secpRegNo: company.secpRegNo ?? '',
  drapLicenceNo: company.drapLicenceNo ?? '',
  contactPhone: company.contactPhone ?? null,
  status: company.status ?? 'active',
  suspendedAt: company.suspendedAt ?? null,
  createdAt: company.createdAt,
});

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number }).code === 11000;

const sameSecp = (): AppError => new AppError('CONFLICT', 'A company with that SECP registration number already exists.');

const findCompany = async (id: string): Promise<PracticeDoc> => {
  const company = Types.ObjectId.isValid(id) ? await Practice.findOne({ _id: id, type: 'company', deletedAt: null }) : null;
  if (!company) {
    throw AppError.notFound('Company');
  }
  return company;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `GET /companies`: by name, searchable anywhere in the name, ignoring case. */
export const listCompanies = async (query: ListCompaniesQuery): Promise<{ companies: CompanyView[]; meta: PageMeta }> => {
  const result = await Practice.paginate(
    {
      type: 'company',
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { name: { $regex: escapeRegex(query.q), $options: 'i' } } : {}),
    },
    { page: query.page, limit: query.limit, sortBy: 'name:asc,_id:asc' },
  );
  return {
    companies: result.results.map(toCompanyView),
    meta: { page: result.page, limit: result.limit, total: result.totalResults, totalPages: result.totalPages },
  };
};

export const getCompany = async (id: string): Promise<CompanyView> => toCompanyView(await findCompany(id));

/** `GET /company`: a company member's own company. */
export const getOwnCompany = async (scope: Scope): Promise<CompanyView> =>
  toCompanyView(await findCompany(String(scope.practiceId)));

/**
 * `POST /companies`: the company and its first admin. The admin's phone gets a
 * `companyAdmin` membership - a user is made if nobody has signed in with it -
 * and an SMS. Audited on the platform, and the membership on the company, both
 * in the name of the platform member who did it.
 */
export const createCompany = async (scope: Audited, body: CreateCompanyBody): Promise<CompanyView> => {
  const { admin, ...fields } = body;
  if (await Practice.exists({ type: 'company', secpRegNo: fields.secpRegNo })) {
    throw sameSecp();
  }

  let company: PracticeDoc;
  try {
    company = await Practice.create({
      ...fields,
      type: 'company',
      status: 'active',
      // The company's first admin is who it belongs to; the platform member made it.
      ownerId: scope.actorId,
      createdBy: scope.actorId,
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw sameSecp();
    }
    throw error;
  }

  const view = toCompanyView(company);
  await writeAudit(scope, {
    action: 'company.create',
    entity: 'practice',
    entityId: company._id,
    after: view,
    requestId: scope.requestId ?? null,
  });

  const member = await grantMembership(
    { practiceId: company._id, actorId: scope.actorId, role: scope.role, allowedLocationIds: [] },
    'company',
    admin,
    'companyAdmin',
    [],
  );
  company.ownerId = new Types.ObjectId(member.userId);
  await company.save();

  return view;
};

/** `PATCH /companies/:id`. A changed SECP number must still be the only one. */
export const updateCompany = async (scope: Audited, id: string, patch: UpdateCompanyBody): Promise<CompanyView> => {
  const company = await findCompany(id);
  if (patch.secpRegNo && patch.secpRegNo !== company.secpRegNo) {
    if (await Practice.exists({ type: 'company', secpRegNo: patch.secpRegNo, _id: { $ne: company._id } })) {
      throw sameSecp();
    }
  }

  const before = toCompanyView(company);
  company.set({ ...patch });
  if (!company.isModified()) {
    return before;
  }
  try {
    await company.save();
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw sameSecp();
    }
    throw error;
  }

  const after = toCompanyView(company);
  await writeAudit(scope, {
    action: 'company.update',
    entity: 'practice',
    entityId: company._id,
    before,
    after,
    requestId: scope.requestId ?? null,
  });
  return after;
};

/**
 * Suspend or reactivate. Suspended, the company's members are refused on every
 * route and their open apps are closed; its pending submissions wait, and a
 * reviewer cannot decide them until it is reactivated; its live products stay,
 * because doctors already rely on them. Doing it twice changes nothing.
 */
const setStatus = async (scope: Audited, id: string, suspended: boolean): Promise<CompanyView> => {
  const company = await findCompany(id);
  const isSuspended = company.status === 'suspended';
  if (isSuspended === suspended) {
    return toCompanyView(company);
  }

  const before = toCompanyView(company);
  company.status = suspended ? 'suspended' : 'active';
  company.suspendedAt = suspended ? new Date() : null;
  await company.save();

  const after = toCompanyView(company);
  await writeAudit(scope, {
    action: suspended ? 'company.suspend' : 'company.reactivate',
    entity: 'practice',
    entityId: company._id,
    before,
    after,
    requestId: scope.requestId ?? null,
  });
  if (suspended) {
    emit('organisation.suspended', { practiceId: company._id, actorId: scope.actorId });
  }
  return after;
};

export const suspendCompany = async (scope: Audited, id: string): Promise<CompanyView> => setStatus(scope, id, true);

export const reactivateCompany = async (scope: Audited, id: string): Promise<CompanyView> => setStatus(scope, id, false);

export default {
  listCompanies,
  getCompany,
  getOwnCompany,
  createCompany,
  updateCompany,
  suspendCompany,
  reactivateCompany,
  toCompanyView,
};
