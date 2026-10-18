import logger from '../config/logger';

export { Practice, type IPractice, type PracticeDoc } from './practice.model';
export { Location, type ILocation, type LocationDoc } from './location.model';
export { User, type IUser, type UserDoc } from './user.model';
export { Membership, type IMembership, type MembershipDoc } from './membership.model';
export { OtpCode, type IOtpCode, type OtpCodeDoc } from './otpCode.model';
export { Patient, type IPatient, type PatientDoc } from './patient.model';
export { Visit, type IVisit, type VisitDoc } from './visit.model';
export { Prescription, type IPrescription, type PrescriptionDoc } from './prescription.model';
export { VoiceSession, type ISegment, type IVoiceSession, type VoiceSessionDoc } from './voiceSession.model';
export { Drug, type IDrug, type DrugDoc } from './drug.model';
export { AuditLog, type IAuditLog, type AuditLogDoc } from './auditLog.model';
export { Notification, type INotification, type NotificationDoc } from './notification.model';
export { Template, type ITemplate, type TemplateDoc } from './template.model';
export { Report, type IReport, type ReportDoc } from './report.model';
export { Lab, type ILab, type LabDoc } from './lab.model';
export { Vital, type IVital, type VitalDoc } from './vital.model';
export { Appointment, type IAppointment, type AppointmentDoc } from './appointment.model';
export { Device, type IDevice, type DeviceDoc } from './device.model';
export { Session, type ISession, type SessionDoc, type SessionRevokedReason } from './session.model';
export { Counter, type ICounter, type CounterDoc } from './counter.model';

/* eslint-disable import/first */
import { Practice } from './practice.model';
import { Location } from './location.model';
import { User } from './user.model';
import { Membership } from './membership.model';
import { OtpCode } from './otpCode.model';
import { Patient } from './patient.model';
import { Visit } from './visit.model';
import { Prescription } from './prescription.model';
import { VoiceSession } from './voiceSession.model';
import { Drug } from './drug.model';
import { AuditLog } from './auditLog.model';
import { Notification } from './notification.model';
import { Template } from './template.model';
import { Report } from './report.model';
import { Lab } from './lab.model';
import { Vital } from './vital.model';
import { Appointment } from './appointment.model';
import { Device } from './device.model';
import { Session } from './session.model';
import { Counter } from './counter.model';

/**
 * Every collection, including the ones no route touches yet.
 *
 * They are all created on boot on purpose: a collection that appears for the
 * first time in six months is a collection someone renames in the meantime.
 */
export const allModels = [
  Practice,
  Location,
  User,
  Membership,
  OtpCode,
  Patient,
  Visit,
  Prescription,
  VoiceSession,
  Drug,
  AuditLog,
  Notification,
  Template,
  Report,
  Lab,
  Vital,
  Appointment,
  Device,
  Session,
  Counter,
];

/**
 * Create every collection and build its indexes.
 *
 * Idempotent, so it is safe to run on every boot. A failure is logged rather
 * than fatal: an index that cannot be built is a problem for the operator, not
 * a reason to refuse to serve traffic.
 */
export const syncCollections = async (): Promise<void> => {
  await Promise.all(
    allModels.map(async (model) => {
      try {
        await model.createCollection();
        await model.createIndexes();
      } catch (error) {
        logger.warn(`could not prepare ${model.collection.name}: ${(error as Error).message}`);
      }
    }),
  );
  logger.info(`${allModels.length} collections ready`);
};
