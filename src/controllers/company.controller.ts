import { auditScope } from '../core/audit';
import { scopeFrom } from '../core/tenancy';
import * as companyService from '../services/company.service';
import * as companyProductService from '../services/companyProduct.service';
import * as submissionService from '../services/submission.service';
import catchAsync from '../utils/catchAsync';
import { parsedBody, parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type {
  ClaimProductBody,
  CompanyCsvBody,
  CreateCompanyBody,
  CreateProductBody,
  ListCompaniesQuery,
  ListCompanyProductsQuery,
  UpdateCompanyBody,
  UpdateProductBody,
} from '../shared/company.schema';

/* RxDictate's view of companies. */

export const listCompanies = catchAsync(async (req, res) => {
  const { companies, meta } = await companyService.listCompanies(parsedQuery<ListCompaniesQuery>(req));
  sendData(res, companies, meta);
});

export const getCompany = catchAsync(async (req, res) => {
  sendData(res, await companyService.getCompany(req.params.id));
});

export const createCompany = catchAsync(async (req, res) => {
  sendCreated(res, await companyService.createCompany(auditScope(req), parsedBody<CreateCompanyBody>(req)));
});

export const updateCompany = catchAsync(async (req, res) => {
  sendData(res, await companyService.updateCompany(auditScope(req), req.params.id, parsedBody<UpdateCompanyBody>(req)));
});

export const suspendCompany = catchAsync(async (req, res) => {
  sendData(res, await companyService.suspendCompany(auditScope(req), req.params.id));
});

export const reactivateCompany = catchAsync(async (req, res) => {
  sendData(res, await companyService.reactivateCompany(auditScope(req), req.params.id));
});

/* A company's own portal. */

export const getOwnCompany = catchAsync(async (req, res) => {
  sendData(res, await companyService.getOwnCompany(scopeFrom(req)));
});

export const listProducts = catchAsync(async (req, res) => {
  const { products, meta } = await companyProductService.listProducts(
    scopeFrom(req),
    parsedQuery<ListCompanyProductsQuery>(req),
  );
  sendData(res, products, meta);
});

/** Each answers with the submission it sent, as GET /submissions/:id would. */
const sent = async (req: Parameters<typeof auditScope>[0], id: unknown) =>
  submissionService.getSubmission({ scope: auditScope(req), organisationType: 'company' }, String(id));

export const createProduct = catchAsync(async (req, res) => {
  const submission = await submissionService.submitCreate(auditScope(req), parsedBody<CreateProductBody>(req));
  sendCreated(res, await sent(req, submission._id));
});

export const updateProduct = catchAsync(async (req, res) => {
  const submission = await submissionService.submitUpdate(
    auditScope(req),
    req.params.id,
    parsedBody<UpdateProductBody>(req),
  );
  sendCreated(res, await sent(req, submission._id));
});

export const discontinueProduct = catchAsync(async (req, res) => {
  const submission = await submissionService.submitDiscontinue(auditScope(req), req.params.id);
  sendCreated(res, await sent(req, submission._id));
});

export const claimProduct = catchAsync(async (req, res) => {
  const submission = await submissionService.submitClaim(auditScope(req), parsedBody<ClaimProductBody>(req));
  sendCreated(res, await sent(req, submission._id));
});

export const checkCsv = catchAsync(async (req, res) => {
  sendData(res, await companyProductService.checkCsv(scopeFrom(req), parsedBody<CompanyCsvBody>(req).csv));
});

export const sendCsv = catchAsync(async (req, res) => {
  sendCreated(res, await companyProductService.sendCsv(auditScope(req), parsedBody<CompanyCsvBody>(req).csv));
});
