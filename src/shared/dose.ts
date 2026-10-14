import type { DosePattern, MedicineItem } from './prescription.schema';

/**
 * Turning a dose into words, in English and Urdu.
 *
 * Derived from the dose and never from the transcriber, so a typed
 * prescription reads exactly like a dictated one and the same dose always
 * produces the same sentence. In src/shared because the app shows these words
 * on screen while the doctor is still editing, and the page prints them an
 * hour later: the two must not be able to disagree about what the patient was
 * told.
 *
 * What the doctor types wins. This is the fallback, not an override.
 */
export type DoseLanguage = 'en' | 'ur';

/** What one dose of this form is called. Urdu counts differently, so both forms are listed. */
const UNITS: Record<MedicineItem['form'], { en: [string, string]; ur: [string, string] }> = {
  tab: { en: ['tablet', 'tablets'], ur: ['گولی', 'گولیاں'] },
  cap: { en: ['capsule', 'capsules'], ur: ['کیپسول', 'کیپسول'] },
  syp: { en: ['spoon', 'spoons'], ur: ['چمچ', 'چمچ'] },
  inj: { en: ['injection', 'injections'], ur: ['ٹیکہ', 'ٹیکے'] },
  drops: { en: ['drop', 'drops'], ur: ['قطرہ', 'قطرے'] },
  cream: { en: ['application', 'applications'], ur: ['بار', 'بار'] },
  ointment: { en: ['application', 'applications'], ur: ['بار', 'بار'] },
  sachet: { en: ['sachet', 'sachets'], ur: ['ساشے', 'ساشے'] },
  spray: { en: ['spray', 'sprays'], ur: ['سپرے', 'سپرے'] },
  other: { en: ['dose', 'doses'], ur: ['خوراک', 'خوراکیں'] },
};

/** The pattern caps at 12, so the list covers everything that can be asked for. */
const URDU_NUMBERS = ['صفر', 'ایک', 'دو', 'تین', 'چار', 'پانچ', 'چھ', 'سات', 'آٹھ', 'نو', 'دس', 'گیارہ', 'بارہ'];

const WHEN = {
  m: { en: 'in the morning', ur: 'صبح' },
  a: { en: 'in the afternoon', ur: 'دوپہر' },
  n: { en: 'at night', ur: 'رات' },
} as const;

const TIMING: Record<MedicineItem['timing'], { en: string; ur: string }> = {
  before_meal: { en: 'before meal', ur: 'کھانے سے پہلے' },
  after_meal: { en: 'after meal', ur: 'کھانے کے بعد' },
  with_meal: { en: 'with meal', ur: 'کھانے کے ساتھ' },
  empty_stomach: { en: 'on an empty stomach', ur: 'نہار منہ' },
  any: { en: '', ur: '' },
};

const AS_NEEDED = { en: 'as needed', ur: 'ضرورت کے وقت' };
const AS_DIRECTED = { en: 'as directed', ur: 'ہدایت کے مطابق' };

const count = (value: number, lang: DoseLanguage): string =>
  lang === 'ur' ? (URDU_NUMBERS[value] ?? String(value)) : String(value);

const unit = (form: MedicineItem['form'], value: number, lang: DoseLanguage): string =>
  UNITS[form][lang][value === 1 ? 0 : 1];

/** "a, b and c" in English; "a، b اور c" in Urdu. */
const join = (parts: string[], lang: DoseLanguage): string => {
  if (parts.length <= 1) return parts[0] ?? '';
  const last = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  const and = lang === 'ur' ? 'اور' : 'and';
  const separator = lang === 'ur' ? '، ' : ', ';
  return `${rest.join(separator)} ${and} ${last}`;
};

const isSos = (pattern: DosePattern): pattern is { sos: true } => 'sos' in pattern;

/**
 * "1 tablet in the morning and 1 tablet at night, after meal"
 * "ایک گولی صبح اور ایک گولی رات کھانے کے بعد"
 *
 * When every time of day takes the same number the unit is said once - "1
 * tablet in the morning and at night" - because that is how a person reads it
 * aloud.
 */
export const doseInstruction = (medicine: Pick<MedicineItem, 'form' | 'pattern' | 'timing'>, lang: DoseLanguage): string => {
  const { form, pattern, timing } = medicine;
  const timingWords = TIMING[timing][lang];

  if (isSos(pattern)) {
    return [AS_NEEDED[lang], timingWords].filter(Boolean).join(lang === 'ur' ? ' ' : ', ');
  }

  const taken = (['m', 'a', 'n'] as const).filter((slot) => pattern[slot] > 0);
  if (taken.length === 0) {
    return AS_DIRECTED[lang];
  }

  const everySlotTheSame = taken.every((slot) => pattern[slot] === pattern[taken[0]]);

  const dose = everySlotTheSame
    ? `${count(pattern[taken[0]], lang)} ${unit(form, pattern[taken[0]], lang)} ${join(
        taken.map((slot) => WHEN[slot][lang]),
        lang,
      )}`
    : join(
        taken.map((slot) => `${count(pattern[slot], lang)} ${unit(form, pattern[slot], lang)} ${WHEN[slot][lang]}`),
        lang,
      );

  // English sets the timing off with a comma; Urdu runs straight on.
  return timingWords ? `${dose}${lang === 'ur' ? ' ' : ', '}${timingWords}` : dose;
};

/**
 * What to print for a medicine: the doctor's own words when there are any,
 * and the dose spelled out when there are not.
 */
export const medicineInstruction = (medicine: MedicineItem, lang: DoseLanguage): string => {
  const typed = lang === 'ur' ? medicine.instructionUr : medicine.instructionEn;
  return typed.trim() !== '' ? typed.trim() : doseInstruction(medicine, lang);
};
