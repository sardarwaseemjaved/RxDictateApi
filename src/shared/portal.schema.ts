import { z } from 'zod';
import { dateStringSchema, objectIdSchema, paginationQuerySchema, sexSchema, timingSchema } from './common';
import { appointmentKindSchema, appointmentStatusSchema } from './appointment.schema';
import { medicineItemSchema, printLanguageSchema } from './prescription.schema';
import { createReportBodySchema, reportSourceSchema, reportTypeSchema } from './report.schema';

/**
 * The patient's own area, and the clinic's controls over it.
 *
 * A patient is not a member of a clinic: a link connects one account to one
 * patient record and gives no clinic rights. These routes need sign-in and no
 * X-Practice-Id.
 *
 * Every view here is written out rather than built from a staff view, so a
 * field added for staff can never reach a patient. They carry only what the
 * clinic has finished: no drafts, edit logs, transcripts or audit data.
 */

/** Unused for this long, a link goes dormant and needs a new code. */
export const PORTAL_LINK_DORMANT_DAYS = 180;

/** How long an invite's code works. */
export const PORTAL_INVITE_EXPIRY_DAYS = 30;

/** At most one invite per record in this long. */
export const PORTAL_INVITE_COOLDOWN_HOURS = 24;

/* ------------------------------------------------------------------ *
 * Linking
 * ------------------------------------------------------------------ */

/** Which code is being tried: an invite's, or the verification code of a printed prescription. */
export const portalLinkKindSchema = z.enum(['invite', 'prescription']);
export type PortalLinkKind = z.infer<typeof portalLinkKindSchema>;

/**
 * POST /portal/links/preview and POST /portal/links. Loose about the code on
 * purpose: a malformed one answers PORTAL_LINK_FAILED like any other that
 * doesn't work.
 */
export const portalLinkBodySchema = z.object({
  kind: portalLinkKindSchema,
  code: z.string().trim().min(1).max(200),
});
export type PortalLinkBody = z.infer<typeof portalLinkBodySchema>;

export const portalPatientSchema = z.object({
  name: z.string(),
  age: z.number().int().nullable(),
  sex: sexSchema,
});
export type PortalPatient = z.infer<typeof portalPatientSchema>;

export const portalClinicSchema = z.object({ name: z.string() });

/** Whose record this is, so a person can see it before tapping "This is mine". */
export const portalLinkPreviewSchema = z.object({
  clinic: portalClinicSchema,
  patient: portalPatientSchema,
});
export type PortalLinkPreview = z.infer<typeof portalLinkPreviewSchema>;

/**
 * - `active`: its records are served.
 * - `dormant`: unused for PORTAL_LINK_DORMANT_DAYS. A new code revives it.
 * - `unavailable`: the clinic has the portal off. Turning it on restores the link.
 */
export const portalLinkStatusSchema = z.enum(['active', 'dormant', 'unavailable']);
export type PortalLinkStatus = z.infer<typeof portalLinkStatusSchema>;

export const portalLinkViewSchema = z.object({
  id: objectIdSchema,
  status: portalLinkStatusSchema,
  linkedAt: z.coerce.date(),
  clinic: portalClinicSchema,
  patient: portalPatientSchema,
});
export type PortalLinkView = z.infer<typeof portalLinkViewSchema>;

export const portalLinkParamsSchema = z.object({ linkId: objectIdSchema });
export const portalRecordParamsSchema = z.object({ linkId: objectIdSchema, id: objectIdSchema });

/* ------------------------------------------------------------------ *
 * Records
 * ------------------------------------------------------------------ */

/** A short-lived link to a file. No Authorization header: the URL is the credential. */
export const portalFileLinkSchema = z.object({
  url: z.string(),
  expiresAt: z.coerce.date(),
  contentType: z.string(),
});
export type PortalFileLink = z.infer<typeof portalFileLinkSchema>;

export const portalPrescriptionStatusSchema = z.enum(['approved', 'superseded']);

/** A row in the list. `replacedBy` is set on a superseded one: the approved version that stands in its place. */
export const portalPrescriptionListItemSchema = z.object({
  id: objectIdSchema,
  number: z.string(),
  version: z.number().int().min(1),
  status: portalPrescriptionStatusSchema,
  approvedAt: z.coerce.date(),
  doctorName: z.string(),
  locationName: z.string(),
  replacedBy: z.object({ id: objectIdSchema, number: z.string(), approvedAt: z.coerce.date() }).nullable(),
});
export type PortalPrescriptionListItem = z.infer<typeof portalPrescriptionListItemSchema>;

const portalTextSchema = z.object({ text: z.string() });

/** The letterhead as it was frozen at approval. */
const portalLetterheadSchema = z.object({
  locationName: z.string(),
  address: z.string(),
  phone: z.string(),
  timings: z.array(timingSchema),
  letterhead: z.object({ en: z.string(), ur: z.string() }),
  doctorName: z.string(),
  qualifications: z.array(z.string()),
  speciality: z.string(),
  pmdcNo: z.string(),
});

/** One prescription as printed. */
export const portalPrescriptionViewSchema = portalPrescriptionListItemSchema.extend({
  printLanguage: printLanguageSchema,
  patient: portalPatientSchema,
  letterhead: portalLetterheadSchema,
  sections: z.object({
    complaints: z.array(portalTextSchema),
    history: z.array(portalTextSchema),
    examination: z.array(portalTextSchema),
    diagnosis: z.array(portalTextSchema),
    medicines: z.array(
      medicineItemSchema.pick({
        name: true,
        strength: true,
        form: true,
        route: true,
        pattern: true,
        timing: true,
        durationDays: true,
        instructionEn: true,
        instructionUr: true,
      }),
    ),
    labs: z.array(portalTextSchema),
    dietEat: z.array(portalTextSchema),
    dietAvoid: z.array(portalTextSchema),
    advice: z.array(portalTextSchema),
    followUp: z.object({ inDays: z.number().int().nullable(), date: dateStringSchema.nullable(), note: z.string() }),
  }),
  verification: z.object({ code: z.string(), url: z.string() }),
});
export type PortalPrescriptionView = z.infer<typeof portalPrescriptionViewSchema>;

export const portalReportViewSchema = z.object({
  id: objectIdSchema,
  type: reportTypeSchema,
  testName: z.string(),
  testDate: dateStringSchema,
  pages: z.number().int().min(1),
  source: reportSourceSchema,
  /** Whether a doctor has looked at it. */
  reviewed: z.boolean(),
  createdAt: z.coerce.date(),
});
export type PortalReportView = z.infer<typeof portalReportViewSchema>;

export const portalReportDetailViewSchema = portalReportViewSchema.extend({
  pageUrls: z.array(portalFileLinkSchema),
});
export type PortalReportDetailView = z.infer<typeof portalReportDetailViewSchema>;

/** Step two of an upload. The pages come from POST /portal/links/:linkId/uploads, for this same link. */
export const portalCreateReportBodySchema = createReportBodySchema.omit({ visitId: true });
export type PortalCreateReportBody = z.infer<typeof portalCreateReportBodySchema>;

export const portalListAppointmentsQuerySchema = paginationQuerySchema.extend({
  /** Left out, it's both, newest first. `upcoming` runs soonest first, and `past` newest first. */
  when: z.enum(['upcoming', 'past']).optional(),
  /** Cancelled bookings stay out unless this asks for them. */
  includeCancelled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type PortalListAppointmentsQuery = z.infer<typeof portalListAppointmentsQuerySchema>;

export const portalAppointmentViewSchema = z.object({
  id: objectIdSchema,
  at: z.coerce.date(),
  kind: appointmentKindSchema,
  status: appointmentStatusSchema,
  locationName: z.string(),
});
export type PortalAppointmentView = z.infer<typeof portalAppointmentViewSchema>;

/**
 * When the doctor asked the patient back, from each approved prescription that
 * says so, latest first. `isOverdue` is a date that has passed with no booking
 * and no visit since.
 */
export const portalFollowUpViewSchema = z.object({
  prescriptionId: objectIdSchema,
  dueDate: dateStringSchema,
  note: z.string(),
  booked: z.boolean(),
  isOverdue: z.boolean(),
});
export type PortalFollowUpView = z.infer<typeof portalFollowUpViewSchema>;

/** Readings from finished visits, newest first. Not what was said at the desk, or who took them. */
export const portalVitalsViewSchema = z.object({
  id: objectIdSchema,
  recordedAt: z.coerce.date(),
  bp: z.string().nullable(),
  pulse: z.number().int().nullable(),
  tempF: z.number().nullable(),
  weightKg: z.number().nullable(),
  spo2: z.number().int().nullable(),
  bloodSugarRandom: z.number().nullable(),
});
export type PortalVitalsView = z.infer<typeof portalVitalsViewSchema>;

/* ------------------------------------------------------------------ *
 * The clinic's controls, under /patients/:id/portal
 * ------------------------------------------------------------------ */

export const patientPortalStateSchema = z.enum(['none', 'invited', 'linked', 'dormant']);
export type PatientPortalState = z.infer<typeof patientPortalStateSchema>;

/** Never says which account holds the link. */
export const patientPortalViewSchema = z.object({
  status: patientPortalStateSchema,
  invitedAt: z.coerce.date().nullable(),
  linkedAt: z.coerce.date().nullable(),
  /** "Don't share online". */
  blocked: z.boolean(),
  /** Whether this clinic's portal is on and the record has a phone. */
  available: z.boolean(),
});
export type PatientPortalView = z.infer<typeof patientPortalViewSchema>;

export const updatePatientPortalBodySchema = z.object({ blocked: z.boolean() });
export type UpdatePatientPortalBody = z.infer<typeof updatePatientPortalBodySchema>;
