/**
 * Timestamps are stored in UTC and shown in Asia/Karachi.
 *
 * Pakistan is UTC+05:00 all year and has not observed daylight saving since
 * 2009, so a fixed offset is exact here. That is worth a dependency-free
 * constant rather than a timezone database.
 */
export const KARACHI_OFFSET_MINUTES = 5 * 60;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** The Karachi calendar day of an instant, as `YYYY-MM-DD`. */
export const karachiDay = (instant: Date = new Date()): string => {
  const shifted = new Date(instant.getTime() + KARACHI_OFFSET_MINUTES * MS_PER_MINUTE);
  return shifted.toISOString().slice(0, 10);
};

export const todayInKarachi = (): string => karachiDay();

/** The UTC instants a Karachi calendar day starts and ends at. */
export const karachiDayRange = (day: string): { start: Date; end: Date } => {
  const start = new Date(`${day}T00:00:00.000Z`).getTime() - KARACHI_OFFSET_MINUTES * MS_PER_MINUTE;
  return { start: new Date(start), end: new Date(start + MS_PER_DAY) };
};

/** Whole years between a `YYYY-MM-DD` date of birth and now. */
export const ageFromDob = (dob: string, now: Date = new Date()): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [year, month, day] = dob.split('-').map(Number);
  const today = karachiDay(now);
  const [ty, tm, td] = today.split('-').map(Number);
  let age = ty - year;
  if (tm < month || (tm === month && td < day)) age -= 1;
  return age < 0 ? null : age;
};

export const addDays = (instant: Date, days: number): Date => new Date(instant.getTime() + days * MS_PER_DAY);

export const addMinutes = (instant: Date, minutes: number): Date => new Date(instant.getTime() + minutes * MS_PER_MINUTE);
