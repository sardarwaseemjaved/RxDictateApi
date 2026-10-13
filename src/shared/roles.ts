import { z } from 'zod';

/**
 * Who someone is inside one practice. A user can hold a different role in each
 * practice they belong to, which is why the role lives on the membership and
 * never on the user.
 */
export const roleSchema = z.enum(['doctor', 'pa', 'patient']);
export type Role = z.infer<typeof roleSchema>;

export const membershipStatusSchema = z.enum(['active', 'removed']);
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;

/**
 * Everything a caller can ask to do. Named `entity.verb`. The role -> action
 * table itself lives in `src/core/permissions`, deliberately in one place; this
 * list is here because the app needs the same names to hide UI it cannot use.
 */
export const ACTIONS = [
  'practice.read',
  'practice.update',

  'location.read',
  'location.create',
  'location.update',
  'location.archive',

  'member.read',
  'member.add',
  'member.update',
  'member.remove',

  'patient.read',
  'patient.search',
  'patient.create',
  'patient.update',
  'patient.history',

  'visit.read',
  'visit.create',
  'visit.update',

  'prescription.read',
  'prescription.create',
  'prescription.update',
  'prescription.approve',
  'prescription.revise',
  'prescription.print',

  'voice.dictate',
  'voice.read',

  'drug.search',

  'template.read',
  'template.create',

  'report.create',
  'report.read',

  'appointment.read',
  'appointment.create',

  'notification.read',
] as const;

export type Action = (typeof ACTIONS)[number];
