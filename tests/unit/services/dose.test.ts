import { doseInstruction, medicineInstruction } from '../../../src/shared/dose';
import { medicineItemSchema, type MedicineItem } from '../../../src/shared/prescription.schema';

const medicine = (overrides: Partial<MedicineItem> = {}): MedicineItem =>
  medicineItemSchema.parse({ id: 'a1', name: 'Panadol', ...overrides });

/**
 * These words are printed on a page a patient takes home and reads without a
 * doctor beside them, so every pattern is spelled out here rather than
 * sampled.
 */
describe('doseInstruction', () => {
  describe('English', () => {
    const en = (overrides: Partial<MedicineItem>) => doseInstruction(medicine(overrides), 'en');

    test('one time of day', () => {
      expect(en({ pattern: { m: 1, a: 0, n: 0 }, timing: 'after_meal' })).toBe('1 tablet in the morning, after meal');
      expect(en({ pattern: { m: 0, a: 1, n: 0 }, timing: 'any' })).toBe('1 tablet in the afternoon');
      expect(en({ pattern: { m: 0, a: 0, n: 1 }, timing: 'before_meal' })).toBe('1 tablet at night, before meal');
    });

    test('says the unit once when every dose is the same', () => {
      expect(en({ pattern: { m: 1, a: 0, n: 1 }, timing: 'after_meal' })).toBe(
        '1 tablet in the morning and at night, after meal',
      );
      expect(en({ pattern: { m: 1, a: 1, n: 1 }, timing: 'after_meal' })).toBe(
        '1 tablet in the morning, in the afternoon and at night, after meal',
      );
      expect(en({ pattern: { m: 2, a: 2, n: 2 }, timing: 'any' })).toBe(
        '2 tablets in the morning, in the afternoon and at night',
      );
    });

    test('spells each out when the doses differ', () => {
      expect(en({ pattern: { m: 1, a: 0, n: 2 }, timing: 'after_meal' })).toBe(
        '1 tablet in the morning and 2 tablets at night, after meal',
      );
      expect(en({ pattern: { m: 2, a: 1, n: 1 }, timing: 'any' })).toBe(
        '2 tablets in the morning, 1 tablet in the afternoon and 1 tablet at night',
      );
    });

    test('as needed', () => {
      expect(en({ pattern: { sos: true }, timing: 'any' })).toBe('as needed');
      expect(en({ pattern: { sos: true }, timing: 'after_meal' })).toBe('as needed, after meal');
    });

    test('a dose of nothing is as directed, not an empty line', () => {
      expect(en({ pattern: { m: 0, a: 0, n: 0 }, timing: 'any' })).toBe('as directed');
    });

    test('every timing has words', () => {
      const timings: MedicineItem['timing'][] = ['before_meal', 'after_meal', 'with_meal', 'empty_stomach', 'any'];
      const lines = timings.map((timing) => en({ pattern: { m: 1, a: 0, n: 0 }, timing }));
      expect(lines).toEqual([
        '1 tablet in the morning, before meal',
        '1 tablet in the morning, after meal',
        '1 tablet in the morning, with meal',
        '1 tablet in the morning, on an empty stomach',
        '1 tablet in the morning',
      ]);
    });

    test('every form has a unit, singular and plural', () => {
      const forms: MedicineItem['form'][] = [
        'tab',
        'cap',
        'syp',
        'inj',
        'drops',
        'cream',
        'ointment',
        'sachet',
        'spray',
        'other',
      ];
      forms.forEach((form) => {
        const one = en({ form, pattern: { m: 1, a: 0, n: 0 }, timing: 'any' });
        const two = en({ form, pattern: { m: 2, a: 0, n: 0 }, timing: 'any' });
        expect(one).toMatch(/^1 \w+ in the morning$/);
        expect(two).toMatch(/^2 \w+ in the morning$/);
      });
      expect(en({ form: 'syp', pattern: { m: 2, a: 0, n: 0 }, timing: 'after_meal' })).toBe(
        '2 spoons in the morning, after meal',
      );
      expect(en({ form: 'drops', pattern: { m: 1, a: 0, n: 0 }, timing: 'any' })).toBe('1 drop in the morning');
    });
  });

  describe('Urdu', () => {
    const ur = (overrides: Partial<MedicineItem>) => doseInstruction(medicine(overrides), 'ur');

    test('one time of day', () => {
      expect(ur({ pattern: { m: 1, a: 0, n: 0 }, timing: 'after_meal' })).toBe('ایک گولی صبح کھانے کے بعد');
      expect(ur({ pattern: { m: 0, a: 0, n: 1 }, timing: 'before_meal' })).toBe('ایک گولی رات کھانے سے پہلے');
    });

    test('says the unit once when every dose is the same', () => {
      expect(ur({ pattern: { m: 1, a: 0, n: 1 }, timing: 'after_meal' })).toBe('ایک گولی صبح اور رات کھانے کے بعد');
      expect(ur({ pattern: { m: 1, a: 1, n: 1 }, timing: 'any' })).toBe('ایک گولی صبح، دوپہر اور رات');
    });

    test('spells each out when the doses differ, and counts in words', () => {
      expect(ur({ pattern: { m: 1, a: 0, n: 2 }, timing: 'after_meal' })).toBe(
        'ایک گولی صبح اور دو گولیاں رات کھانے کے بعد',
      );
      expect(ur({ pattern: { m: 3, a: 0, n: 0 }, timing: 'any' })).toBe('تین گولیاں صبح');
    });

    test('as needed, and as directed', () => {
      expect(ur({ pattern: { sos: true }, timing: 'any' })).toBe('ضرورت کے وقت');
      expect(ur({ pattern: { sos: true }, timing: 'after_meal' })).toBe('ضرورت کے وقت کھانے کے بعد');
      expect(ur({ pattern: { m: 0, a: 0, n: 0 }, timing: 'any' })).toBe('ہدایت کے مطابق');
    });

    test('every timing has Urdu words', () => {
      expect(ur({ pattern: { m: 1, a: 0, n: 0 }, timing: 'empty_stomach' })).toBe('ایک گولی صبح نہار منہ');
      expect(ur({ pattern: { m: 1, a: 0, n: 0 }, timing: 'with_meal' })).toBe('ایک گولی صبح کھانے کے ساتھ');
    });

    test('every form has an Urdu unit and never falls back to English', () => {
      const forms: MedicineItem['form'][] = [
        'tab',
        'cap',
        'syp',
        'inj',
        'drops',
        'cream',
        'ointment',
        'sachet',
        'spray',
        'other',
      ];
      forms.forEach((form) => {
        const line = ur({ form, pattern: { m: 2, a: 0, n: 0 }, timing: 'any' });
        expect(line).toMatch(/^دو /);
        expect(line).not.toMatch(/[A-Za-z]/);
      });
    });

    test('counts up to the twelve the pattern allows', () => {
      expect(ur({ pattern: { m: 12, a: 0, n: 0 }, timing: 'any' })).toBe('بارہ گولیاں صبح');
    });
  });

  describe('medicineInstruction', () => {
    test("uses the doctor's own words when there are any", () => {
      const typed = medicine({
        pattern: { m: 1, a: 0, n: 0 },
        instructionEn: 'Half a tablet only if the fever returns',
        instructionUr: 'بخار ہو تو آدھی گولی',
      });
      expect(medicineInstruction(typed, 'en')).toBe('Half a tablet only if the fever returns');
      expect(medicineInstruction(typed, 'ur')).toBe('بخار ہو تو آدھی گولی');
    });

    test('falls back to the dose per language, independently', () => {
      const half = medicine({ pattern: { m: 1, a: 0, n: 1 }, timing: 'after_meal', instructionEn: 'With water' });
      expect(medicineInstruction(half, 'en')).toBe('With water');
      // Nothing was typed in Urdu, so the dose speaks for itself.
      expect(medicineInstruction(half, 'ur')).toBe('ایک گولی صبح اور رات کھانے کے بعد');
    });

    test('whitespace is not an instruction', () => {
      const blank = medicine({ pattern: { m: 1, a: 0, n: 0 }, timing: 'any', instructionEn: '   ' });
      expect(medicineInstruction(blank, 'en')).toBe('1 tablet in the morning');
    });
  });
});
