import express from 'express';
import config from '../../config/config';
import authRoute from './auth.route';
import meRoute from './me.route';
import practiceRoute from './practice.route';
import practicesRoute from './practices.route';
import locationRoute from './location.route';
import teamRoute from './team.route';
import patientRoute from './patient.route';
import visitRoute from './visit.route';
import prescriptionRoute from './prescription.route';
import voiceRoute from './voice.route';
import drugRoute from './drug.route';
import notificationRoute from './notification.route';
import deviceRoute from './device.route';
import templateRoute from './template.route';
import verifyRoute from './verify.route';
import reportRoute from './report.route';
import appointmentRoute from './appointment.route';
import followUpRoute from './followUp.route';
import portalRoute from './portal.route';
import fileRoute, { servesLocalFiles } from './file.route';
import docsRoute from './docs.route';

const router = express.Router();

/**
 * Everything the app can call, mounted under /api/v1.
 *
 * The routes that are not built yet are here too, answering 501 behind the same
 * auth, tenancy and permission chain as the rest. The app can link to them
 * today and nothing gets renamed when they go live.
 *
 * Every route except /auth needs X-Practice-Id. /me is the exception that
 * proves it: its answer is what tells the app which practice ids exist.
 *
 * Two more are outside that rule, and outside sign-in altogether: /verify,
 * which a pharmacist reaches by scanning a printout, and /files below, where a
 * signed link is the credential.
 */
const routes = [
  { path: '/auth', route: authRoute },
  { path: '/me', route: meRoute },
  { path: '/practice', route: practiceRoute },
  { path: '/practices', route: practicesRoute },
  { path: '/locations', route: locationRoute },
  { path: '/members', route: teamRoute },
  { path: '/patients', route: patientRoute },
  { path: '/visits', route: visitRoute },
  { path: '/prescriptions', route: prescriptionRoute },
  { path: '/voice', route: voiceRoute },
  { path: '/drugs', route: drugRoute },
  { path: '/appointments', route: appointmentRoute },
  { path: '/follow-ups', route: followUpRoute },
  { path: '/reports', route: reportRoute },
  { path: '/notifications', route: notificationRoute },
  { path: '/templates', route: templateRoute },
  // Public: a printout's QR code. No sign-in and no X-Practice-Id.
  { path: '/verify', route: verifyRoute },
  // Not built yet; mounted so the app can link to them.
  { path: '/devices', route: deviceRoute },
  { path: '/portal', route: portalRoute },
];

routes.forEach((route) => {
  router.use(route.path, route.route);
});

/**
 * Downloads and uploads for the local storage driver. Not mounted at all with
 * S3 or R2, where the bucket serves its own presigned URLs.
 */
if (servesLocalFiles()) {
  router.use('/files', fileRoute);
}

/* istanbul ignore next */
if (config.env === 'development') {
  router.use('/docs', docsRoute);
}

export default router;
