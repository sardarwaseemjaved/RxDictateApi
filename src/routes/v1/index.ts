import express from 'express';
import config from '../../config/config';
import docsRoute from './docs.route';

const router = express.Router();

/* istanbul ignore next */
if (config.env === 'development') {
  router.use('/docs', docsRoute);
}

export default router;
