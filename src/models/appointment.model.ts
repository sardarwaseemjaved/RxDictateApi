import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';
import type { AppointmentKind, AppointmentStatus } from '../shared/appointment.schema';

/**
 * A booked slot. Unlike a visit, which is a day on a list, an appointment is an
 * instant, so `at` is a real UTC timestamp.
 */
export interface IAppointment {
  practiceId: Types.ObjectId;
  locationId: Types.ObjectId;
  patientId: Types.ObjectId;
  at: Date;
  kind: AppointmentKind;
  status: AppointmentStatus;
  note: string;
  /**
   * The approved prescription whose follow-up this books. Set here is what
   * takes the follow-up off the "to book" list, so there is no second place
   * that has to be kept in step.
   */
  prescriptionId: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  cancelledAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type AppointmentDoc = HydratedDocument<IAppointment>;

const appointmentSchema = new Schema<IAppointment>(
  {
    practiceId: { type: Schema.Types.ObjectId, ref: 'Practice', required: true },
    locationId: { type: Schema.Types.ObjectId, ref: 'Location', required: true },
    patientId: { type: Schema.Types.ObjectId, ref: 'Patient', required: true },
    at: { type: Date, required: true },
    kind: { type: String, enum: ['follow_up', 'new_problem'], default: 'new_problem' },
    status: { type: String, enum: ['booked', 'cancelled', 'arrived'], default: 'booked' },
    note: { type: String, default: '', trim: true },
    prescriptionId: { type: Schema.Types.ObjectId, ref: 'Prescription', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    cancelledAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

appointmentSchema.plugin(toJSON);
appointmentSchema.plugin(paginate);

appointmentSchema.index({ practiceId: 1, locationId: 1, at: 1 });
appointmentSchema.index({ practiceId: 1, prescriptionId: 1 });
/**
 * One booking per slot, enforced by the database rather than by a check that
 * two simultaneous bookings would both pass. Partial, so a cancelled
 * appointment frees its slot instead of blocking it forever.
 */
appointmentSchema.index(
  { practiceId: 1, locationId: 1, at: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'booked' } },
);

export const Appointment = mongoose.model<IAppointment, PaginateModel<IAppointment>>(
  'Appointment',
  appointmentSchema,
  'appointments',
);
export default Appointment;
