import { idParamSchema } from '../shared/common';
import {
  createAppointmentBodySchema,
  listAppointmentsQuerySchema,
  listFollowUpsQuerySchema,
} from '../shared/appointment.schema';

export const listAppointments = { query: listAppointmentsQuerySchema };
export const createAppointment = { body: createAppointmentBodySchema };
export const cancelAppointment = { params: idParamSchema };
export const listFollowUps = { query: listFollowUpsQuerySchema };
