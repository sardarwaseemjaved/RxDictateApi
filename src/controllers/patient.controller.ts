import { scopeFrom } from '../core/tenancy';
import * as patientService from '../services/patient.service';
import * as historyService from '../services/history.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { CreatePatientBody, SearchPatientsQuery, UpdatePatientBody } from '../shared/patient.schema';
import type { ListHistoryQuery } from '../shared/history.schema';

export const searchPatients = catchAsync(async (req, res) => {
  const { patients, meta } = await patientService.searchPatients(scopeFrom(req), parsedQuery<SearchPatientsQuery>(req));
  sendData(res, patients, meta);
});

export const getPatient = catchAsync(async (req, res) => {
  sendData(res, await patientService.getPatient(scopeFrom(req), req.params.id));
});

export const createPatient = catchAsync(async (req, res) => {
  sendCreated(res, await patientService.createPatient(scopeFrom(req), req.body as CreatePatientBody));
});

export const updatePatient = catchAsync(async (req, res) => {
  sendData(res, await patientService.updatePatient(scopeFrom(req), req.params.id, req.body as UpdatePatientBody));
});

export const getHistory = catchAsync(async (req, res) => {
  const { items, meta } = await historyService.getHistory(scopeFrom(req), req.params.id, parsedQuery<ListHistoryQuery>(req));
  sendData(res, items, meta);
});
