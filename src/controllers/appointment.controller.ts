import { scopeFrom } from '../core/tenancy';
import * as appointmentService from '../services/appointment.service';
import catchAsync from '../utils/catchAsync';
import { parsedQuery } from '../utils/request';
import { sendCreated, sendData } from '../utils/response';
import type { CreateAppointmentBody, ListAppointmentsQuery, ListFollowUpsQuery } from '../shared/appointment.schema';

export const listAppointments = catchAsync(async (req, res) => {
  const { appointments, meta } = await appointmentService.listAppointments(
    scopeFrom(req),
    parsedQuery<ListAppointmentsQuery>(req),
  );
  sendData(res, appointments, meta);
});

export const createAppointment = catchAsync(async (req, res) => {
  sendCreated(res, await appointmentService.createAppointment(scopeFrom(req), req.body as CreateAppointmentBody));
});

export const cancelAppointment = catchAsync(async (req, res) => {
  sendData(res, await appointmentService.cancelAppointment(scopeFrom(req), req.params.id));
});

export const listFollowUps = catchAsync(async (req, res) => {
  const { followUps, meta } = await appointmentService.listFollowUps(scopeFrom(req), parsedQuery<ListFollowUpsQuery>(req));
  sendData(res, followUps, meta);
});
