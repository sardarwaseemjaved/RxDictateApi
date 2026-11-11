import logger from '../config/logger';

export { Practice, type IPractice, type PracticeDoc } from './practice.model';
export { Location, type ILocation, type LocationDoc } from './location.model';
export { User, type IUser, type UserDoc } from './user.model';
export { Membership, type IMembership, type MembershipDoc } from './membership.model';
export { OtpCode, type IOtpCode, type OtpCodeDoc } from './otpCode.model';
export { Patient, type IPatient, type PatientDoc } from './patient.model';
export {
  PatientLink,
  LIVE_LINK_STATUSES,
  type IPatientLink,
  type PatientLinkDoc,
  type PatientLinkEndReason,
} from './patientLink.model';
export { PatientInvite, type IPatientInvite, type PatientInviteDoc } from './patientInvite.model';
export { PatientIntroduction, type IPatientIntroduction, type PatientIntroductionDoc } from './patientIntroduction.model';
export { Visit, type IVisit, type VisitDoc } from './visit.model';
export { Prescription, type IPrescription, type PrescriptionDoc } from './prescription.model';
export { VoiceSession, type ISegment, type IVoiceSession, type VoiceSessionDoc } from './voiceSession.model';
export { Drug, drugKeys, identityKeyOf, normaliseName, type IDrug, type DrugDoc } from './drug.model';
export { DrugList, type IDrugList, type IDrugListItem, type DrugListDoc } from './drugList.model';
export { DrugUsage, type IDrugUsage, type DrugUsageDoc } from './drugUsage.model';
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
export { Setting, type ISetting, type SettingDoc } from './setting.model';
export { Submission, QUEUE_RANK, type ISubmission, type ISubmissionStep, type SubmissionDoc } from './submission.model';
export {
  Announcement,
  type IAnnouncement,
  type IAnnouncementAudience,
  type IAnnouncementEvent,
  type AnnouncementDoc,
} from './announcement.model';
export { AnnouncementState, type IAnnouncementState, type AnnouncementStateDoc } from './announcementState.model';
export {
  AnnouncementRegistration,
  type IAnnouncementRegistration,
  type AnnouncementRegistrationDoc,
} from './announcementRegistration.model';
export { Job, JOB_TYPES, type IJob, type JobDoc, type JobStatus, type JobType } from './job.model';

/* eslint-disable import/first */
import { Practice } from './practice.model';
import { Location } from './location.model';
import { User } from './user.model';
import { Membership } from './membership.model';
import { OtpCode } from './otpCode.model';
import { Patient } from './patient.model';
import { PatientLink } from './patientLink.model';
import { PatientInvite } from './patientInvite.model';
import { PatientIntroduction } from './patientIntroduction.model';
import { Visit } from './visit.model';
import { Prescription } from './prescription.model';
import { VoiceSession } from './voiceSession.model';
import { Drug, RETIRED_DRUG_INDEXES } from './drug.model';
import { DrugList } from './drugList.model';
import { DrugUsage } from './drugUsage.model';
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
import { Setting } from './setting.model';
import { Submission } from './submission.model';
import { Announcement } from './announcement.model';
import { AnnouncementState } from './announcementState.model';
import { AnnouncementRegistration } from './announcementRegistration.model';
import { Job } from './job.model';

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
  PatientLink,
  PatientInvite,
  PatientIntroduction,
  Visit,
  Prescription,
  VoiceSession,
  Drug,
  DrugList,
  DrugUsage,
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
  Setting,
  Submission,
  Announcement,
  AnnouncementState,
  AnnouncementRegistration,
  Job,
];

/**
 * Indexes the code no longer declares, which createIndexes would otherwise
 * leave in place for good. The old unique brand, strength and form on `drugs`
 * is the one that matters: it refuses the one copy per doctor that the catalog
 * is now made of.
 */
const dropRetiredIndexes = async (): Promise<void> => {
  await Promise.all(
    RETIRED_DRUG_INDEXES.map(async (name) => {
      try {
        if (await Drug.collection.indexExists(name)) {
          await Drug.collection.dropIndex(name);
        }
      } catch (error) {
        logger.warn(`could not drop the old index ${name} on drugs: ${(error as Error).message}`);
      }
    }),
  );
};

/**
 * `vitals.visitId_1` was first built without `unique`. createIndexes neither
 * changes an index nor replaces one of the same name, so a database from then
 * warns on every boot and never gets the one-per-visit rule. The old index is
 * dropped here so the unique one can be built, unless two readings already
 * share a visit: that would fail the build and leave the lookup with no index,
 * so the old one stays until somebody has looked at those readings.
 */
const makeVitalsIndexUnique = async (): Promise<void> => {
  try {
    await Vital.createCollection();
    const old = (await Vital.collection.indexes()).find((index) => index.name === 'visitId_1');
    if (!old || old.unique) {
      return;
    }
    const [repeated] = await Vital.collection
      .aggregate<{ visits: number }>([
        { $group: { _id: '$visitId', readings: { $sum: 1 } } },
        { $match: { readings: { $gt: 1 } } },
        { $count: 'visits' },
      ])
      .toArray();
    if (repeated) {
      logger.warn(
        `vitals: ${repeated.visits === 1 ? '1 visit has' : `${repeated.visits} visits have`} more than one set of vitals, so the index cannot be made unique yet`,
      );
      return;
    }
    await Vital.collection.dropIndex('visitId_1');
  } catch (error) {
    logger.warn(`could not make the vitals index unique: ${(error as Error).message}`);
  }
};

/**
 * Create every collection and build its indexes.
 *
 * Idempotent, so it is safe to run on every boot. A failure is logged rather
 * than fatal: an index that cannot be built is a problem for the operator, not
 * a reason to refuse to serve traffic.
 */
export const syncCollections = async (): Promise<void> => {
  await Drug.createCollection();
  await dropRetiredIndexes();
  await makeVitalsIndexUnique();
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
