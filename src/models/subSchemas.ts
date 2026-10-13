import { Schema } from 'mongoose';
import type { Bilingual, Timing } from '../shared/common';

/** Anything that prints in Urdu carries both renderings. */
export const bilingualSubSchema = new Schema<Bilingual>(
  {
    en: { type: String, default: '' },
    ur: { type: String, default: '' },
  },
  { _id: false },
);

export const timingSubSchema = new Schema<Timing>(
  {
    day: { type: String, enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], required: true },
    from: { type: String, default: '09:00' },
    to: { type: String, default: '17:00' },
    closed: { type: Boolean, default: false },
  },
  { _id: false },
);
