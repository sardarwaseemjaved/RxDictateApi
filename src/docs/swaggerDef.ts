import config from '../config/config';

/**
 * The served OpenAPI document describes the envelope and points at
 * `src/shared`, which is the actual contract: those zod schemas are imported by
 * the app, so duplicating every request shape in YAML here would only give it
 * something to drift from. `src/docs/paths.yml` describes the routes whose
 * behaviour needs more than a name - the signed file routes, history, templates
 * - and names the shared schema each one takes and returns.
 */
const swaggerDef = {
  openapi: '3.0.0',
  info: {
    title: 'Clinic API',
    version: config.version,
    description:
      'Prescription writing for Pakistani doctors. Request and response shapes are defined as zod schemas in src/shared and shared with the mobile app.',
  },
  servers: [
    {
      url: `http://localhost:${config.port}/api/v1`,
    },
  ],
};

export default swaggerDef;
