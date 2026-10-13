import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';
import { paginate, toJSON, type PaginateModel } from './plugins';

/**
 * A booked slot. Unlike a visit, which is a day on a list, an appointment is an
 * instant, so `at` is a real UTC timestamp.
 */
export interface IAppointment {
  practiceId: Types.ObjectId;
  locationId: Types.ObjectId;
  patientId: Types.ObjectId;
  at: Date;
  status: 'booked' | 'cancelled' | 'arrived' | 'done';
  createdBy: Types.ObjectId;
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
    status: { type: String, enum: ['booked', 'cancelled', 'arrived', 'done'], default: 'booked' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

appointmentSchema.plugin(toJSON);
appointmentSchema.plugin(paginate);

appointmentSchema.index({ practiceId: 1, locationId: 1, at: 1 });

export const Appointment = mongoose.model<IAppointment, PaginateModel<IAppointment>>(
  'Appointment',
  appointmentSchema,
  'appointments',
);
export default Appointment;
