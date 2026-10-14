import { VITAL_RANGES, parseBp, vitalFlags } from '../../../src/shared/vitals.schema';

/**
 * This function is in src/shared because the app highlights a reading the
 * moment it is typed and the server flags the same reading for the doctor. The
 * two disagreeing in front of a patient would be worse than either being
 * slightly wrong, so it is one function with one set of tests.
 */
describe('vitalFlags', () => {
  test('says nothing when everything is normal', () => {
    expect(vitalFlags({ bp: '120/80', pulse: 72, tempF: 98.4, spo2: 98, bloodSugarRandom: 100 })).toEqual([]);
  });

  test('flags a high pulse and a low one', () => {
    expect(vitalFlags({ pulse: 130 })).toEqual([{ field: 'pulse', level: 'high', value: 130, range: VITAL_RANGES.pulse }]);
    expect(vitalFlags({ pulse: 44 })[0]).toMatchObject({ field: 'pulse', level: 'low' });
  });

  test('splits a blood pressure and judges each half', () => {
    expect(vitalFlags({ bp: '160/95' }).map((flag) => `${flag.field}:${flag.level}`)).toEqual([
      'systolic:high',
      'diastolic:high',
    ]);
    expect(vitalFlags({ bp: '150/80' }).map((flag) => flag.field)).toEqual(['systolic']);
    expect(vitalFlags({ bp: '85/55' }).map((flag) => `${flag.field}:${flag.level}`)).toEqual([
      'systolic:low',
      'diastolic:low',
    ]);
  });

  test('flags a fever and low oxygen', () => {
    expect(vitalFlags({ tempF: 101.2 })[0]).toMatchObject({ field: 'tempF', level: 'high' });
    expect(vitalFlags({ spo2: 91 })[0]).toMatchObject({ field: 'spo2', level: 'low' });
    // spo2 has no upper bound: nobody is too well oxygenated.
    expect(vitalFlags({ spo2: 100 })).toEqual([]);
  });

  test('ignores readings that were not taken', () => {
    expect(vitalFlags({})).toEqual([]);
    expect(vitalFlags({ pulse: null, tempF: null, bp: null, bloodSugarRandom: null })).toEqual([]);
  });

  test('ignores a blood pressure it cannot read rather than guessing', () => {
    expect(parseBp('not a bp')).toBeNull();
    expect(parseBp(null)).toBeNull();
    expect(vitalFlags({ bp: 'high' })).toEqual([]);
  });

  test('weight is never flagged, because a normal weight needs an age', () => {
    expect(vitalFlags({ weightKg: 3 })).toEqual([]);
    expect(vitalFlags({ weightKg: 180 })).toEqual([]);
  });
});
