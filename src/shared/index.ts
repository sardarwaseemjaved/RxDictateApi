/**
 * The request/response contract, as zod schemas plus the types inferred from
 * them.
 *
 * This folder is the single source of truth for every shape that crosses the
 * wire and is imported by both this API and the React Native app, so a change
 * here is a change in both places at once. Nothing in here may import anything
 * from outside `src/shared` apart from zod: the app has no express, no
 * mongoose and no node built-ins.
 */
export * from './errorCodes';
export * from './response';
export * from './roles';
export * from './common';
export * from './auth.schema';
export * from './me.schema';
export * from './practice.schema';
export * from './location.schema';
export * from './team.schema';
export * from './patient.schema';
export * from './visit.schema';
export * from './prescription.schema';
export * from './dose';
export * from './vitals.schema';
export * from './report.schema';
export * from './appointment.schema';
export * from './history.schema';
export * from './template.schema';
export * from './voice.schema';
export * from './drug.schema';
export * from './notification.schema';
export * from './realtime.schema';
export * from './verify.schema';
