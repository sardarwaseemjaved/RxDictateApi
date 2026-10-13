import express from 'express';
import config from '../../config/config';
import authRoute from './auth.route';
import meRoute from './me.route';
import practiceRoute from './practice.route';
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
import reportRoute from './report.route';
import appointmentRoute from './appointment.route';
import portalRoute from './portal.route';
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
 */
const routes = [
  { path: '/auth', route: authRoute },
  { path: '/me', route: meRoute },
  { path: '/practice', route: practiceRoute },
  { path: '/locations', route: locationRoute },
  { path: '/members', route: teamRoute },
  { path: '/patients', route: patientRoute },
  { path: '/visits', route: visitRoute },
  { path: '/prescriptions', route: prescriptionRoute },
  { path: '/voice', route: voiceRoute },
  { path: '/drugs', route: drugRoute },
  // Written, not yet read.
  { path: '/notifications', route: notificationRoute },
  { path: '/devices', route: deviceRoute },
  { path: '/templates', route: templateRoute },
  { path: '/reports', route: reportRoute },
  { path: '/appointments', route: appointmentRoute },
  { path: '/portal', route: portalRoute },
];

routes.forEach((route) => {
  router.use(route.path, route.route);
});

/* istanbul ignore next */
if (config.env === 'development') {
  router.use('/docs', docsRoute);
}

export default router;
