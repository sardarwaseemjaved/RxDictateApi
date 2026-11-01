import { z } from 'zod';
import { dateStringSchema, objectIdSchema } from './common';
import { patientViewSchema } from './patient.schema';

export const appointmentKindSchema = z.enum(['follow_up', 'new_problem']);
export type AppointmentKind = z.infer<typeof appointmentKindSchema>;

/**
 * `arrived` is set by the server when a visit is created for the patient on
 * the appointment's day at its location. The Schedule lists `booked` and
 * `arrived` together; `cancelled` drops off it.
 */
export const appointmentStatusSchema = z.enum(['booked', 'cancelled', 'arrived']);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

export const appointmentViewSchema = z.object({
  id: objectIdSchema,
  locationId: objectIdSchema,
  patient: patientViewSchema.nullable(),
  /** A real instant, unlike a visit, which is a day on a list. */
  at: z.coerce.date(),
  kind: appointmentKindSchema,
  status: appointmentStatusSchema,
  note: z.string(),
  /** The prescription whose follow-up this books, when it books one. */
  prescriptionId: objectIdSchema.nullable(),
});
export type AppointmentView = z.infer<typeof appointmentViewSchema>;

export const listAppointmentsQuerySchema = z
  .object({
    from: dateStringSchema,
    to: dateStringSchema,
  })
  .refine((query) => query.from <= query.to, 'from must not be after to');
export type ListAppointmentsQuery = z.infer<typeof listAppointmentsQuerySchema>;

/** `{ "2026-09-26": 5 }`, for the seven-day strip above the list. */
export const appointmentCountsByDaySchema = z.record(dateStringSchema, z.number().int().min(0));
export type AppointmentCountsByDay = z.infer<typeof appointmentCountsByDaySchema>;

export const createAppointmentBodySchema = z.object({
  patientId: objectIdSchema,
  at: z.coerce.date(),
  kind: appointmentKindSchema,
  note: z.string().trim().max(500).default(''),
  prescriptionId: objectIdSchema.nullable().optional(),
});
export type CreateAppointmentBody = z.infer<typeof createAppointmentBodySchema>;

/**
 * A follow-up the doctor asked for that nobody has booked yet.
 *
 * Derived rather than stored: it is an approved prescription whose followUp has
 * a date, with no booked appointment pointing back at it. Booking one with its
 * prescriptionId is what takes it off this list, so there is no second place
 * that has to be kept in step.
 */
export const followUpViewSchema = z.object({
  prescriptionId: objectIdSchema,
  patient: patientViewSchema.nullable(),
  dueDate: dateStringSchema,
  note: z.string(),
  isOverdue: z.boolean(),
});
export type FollowUpView = z.infer<typeof followUpViewSchema>;

export const listFollowUpsQuerySchema = z.object({
  status: z.literal('unbooked').default('unbooked'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListFollowUpsQuery = z.infer<typeof listFollowUpsQuerySchema>;
