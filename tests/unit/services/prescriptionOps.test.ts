import { Types } from 'mongoose';
import { applyOps, isEmpty, validateOps, wireSections } from '../../../src/services/prescriptionOps.service';
import { AppError } from '../../../src/core/errors';
import { prescriptionSectionsSchema, type Op } from '../../../src/shared/prescription.schema';

const actorId = new Types.ObjectId();
const empty = () => prescriptionSectionsSchema.parse({});

const run = (ops: Op[], from = empty(), origin: 'typed' | 'voice' = 'typed') => applyOps(from, ops, { actorId, origin });

const op = (partial: Partial<Op> & Pick<Op, 'op' | 'section'>): Op => ({
  itemId: null,
  value: undefined,
  spanIds: [],
  ...partial,
});

describe('The ops engine', () => {
  describe('adding', () => {
    test('mints an id and keeps the span the line came from', () => {
      const { sections } = run([op({ op: 'add', section: 'complaints', value: { text: 'Bukhar' }, spanIds: ['span-1'] })]);

      expect(sections.complaints).toHaveLength(1);
      expect(sections.complaints[0].id).toMatch(/^[0-9a-f]{12}$/);
      expect(sections.complaints[0].sourceSpanIds).toEqual(['span-1']);
    });

    test('fills a medicine out from the contract defaults', () => {
      const { sections } = run([op({ op: 'add', section: 'medicines', value: { name: 'Panadol' } })]);

      expect(sections.medicines[0]).toMatchObject({
        name: 'Panadol',
        form: 'tab',
        route: 'oral',
        pattern: { m: 1, a: 0, n: 0 },
        timing: 'any',
        durationDays: 0,
        flags: [],
        correctedBySpeech: false,
        drugId: null,
      });
    });

    test('accepts both dose patterns and nothing else', () => {
      expect(
        run([op({ op: 'add', section: 'medicines', value: { name: 'A', pattern: { sos: true } } })]).sections.medicines[0]
          .pattern,
      ).toEqual({ sos: true });
      expect(
        run([op({ op: 'add', section: 'medicines', value: { name: 'A', pattern: { m: 2, a: 1, n: 2 } } })]).sections
          .medicines[0].pattern,
      ).toEqual({ m: 2, a: 1, n: 2 });

      expect(() => run([op({ op: 'add', section: 'medicines', value: { name: 'A', pattern: { m: 1 } } })])).toThrow(
        AppError,
      );
      expect(() => run([op({ op: 'add', section: 'medicines', value: { name: 'A', pattern: 'twice a day' } })])).toThrow(
        AppError,
      );
    });

    test('strips a field the section does not have', () => {
      const { sections } = run([
        op({ op: 'add', section: 'advice', value: { text: 'Rest', priority: 'urgent', id: 'mine' } }),
      ]);

      expect(sections.advice[0]).not.toHaveProperty('priority');
      expect(sections.advice[0].id).not.toBe('mine');
    });

    test('refuses an id the caller tried to choose', () => {
      expect(() => run([op({ op: 'add', section: 'advice', itemId: 'mine', value: { text: 'Rest' } })])).toThrow(
        /the server mints one/,
      );
    });

    test('refuses a value that is missing a required field', () => {
      expect(() => run([op({ op: 'add', section: 'complaints', value: {} })])).toThrow(/text/);
      expect(() => run([op({ op: 'add', section: 'medicines', value: { strength: '500mg' } })])).toThrow(/name/);
    });

    test('refuses an op with no value at all', () => {
      expect(() => run([op({ op: 'add', section: 'complaints' })])).toThrow(/a value is required/);
    });
  });

  describe('updating and removing', () => {
    const withOne = () => run([op({ op: 'add', section: 'diagnosis', value: { text: 'Dengue' } })]).sections;

    test('merges into the item and leaves its id alone', () => {
      const start = withOne();
      const itemId = start.diagnosis[0].id;

      const { sections } = run([op({ op: 'update', section: 'diagnosis', itemId, value: { code: 'A90' } })], start);

      expect(sections.diagnosis[0]).toMatchObject({ id: itemId, text: 'Dengue', code: 'A90' });
    });

    test('removes by id', () => {
      const start = withOne();
      const { sections } = run([op({ op: 'remove', section: 'diagnosis', itemId: start.diagnosis[0].id })], start);
      expect(sections.diagnosis).toHaveLength(0);
    });

    test('refuses an item id that is not there', () => {
      expect(() => run([op({ op: 'update', section: 'diagnosis', itemId: 'ghost', value: { text: 'x' } })])).toThrow(
        /there is no item ghost in diagnosis/,
      );
      expect(() => run([op({ op: 'remove', section: 'advice', itemId: 'ghost' })])).toThrow(/no item ghost/);
    });

    test('refuses an update with no item id', () => {
      expect(() => run([op({ op: 'update', section: 'advice', value: { text: 'x' } })])).toThrow(/an itemId is required/);
    });

    test('refuses removing the same item twice in one batch', () => {
      const start = withOne();
      const itemId = start.diagnosis[0].id;
      expect(() =>
        run([op({ op: 'remove', section: 'diagnosis', itemId }), op({ op: 'remove', section: 'diagnosis', itemId })], start),
      ).toThrow(/no item/);
    });
  });

  describe('an update changes only what it was given', () => {
    /**
     * The bug this guards: the item schemas carry defaults, and .partial()
     * does not stop a default firing for a key that was left out. Parsing
     * { name } came back with every other field filled in, and merging that
     * over the stored line reset the dose, the strength, the form and the
     * duration - a medicine moving from night to morning because somebody
     * confirmed its name.
     */
    test('confirming a medicine by name leaves every other field untouched', () => {
      const start = run([
        op({
          op: 'add',
          section: 'medicines',
          value: {
            name: 'Rosuvastatin',
            strength: '10 mg',
            form: 'cap',
            pattern: { m: 0, a: 0, n: 1 },
            timing: 'after_meal',
            durationDays: 30,
            flags: ['dose_unclear'],
          },
        }),
      ]).sections;
      const stored = start.medicines[0];
      const { itemId } = { itemId: stored.id };

      const { sections } = run([op({ op: 'update', section: 'medicines', itemId, value: { name: 'Rosuvastatin' } })], start);
      const after = sections.medicines[0];

      expect(after.strength).toBe('10 mg');
      expect(after.form).toBe('cap');
      expect(after.pattern).toEqual({ m: 0, a: 0, n: 1 });
      expect(after.timing).toBe('after_meal');
      expect(after.durationDays).toBe(30);
      // Everything except the flags, which a typed edit clears on purpose:
      // the doctor has now looked at the line.
      expect({ ...after, flags: stored.flags }).toEqual(stored);
      expect(after.flags).toEqual([]);
    });

    test('a one-field update to a medicine touches one field', () => {
      const start = run([
        op({
          op: 'add',
          section: 'medicines',
          value: {
            name: 'Panadol',
            strength: '500 mg',
            form: 'tab',
            pattern: { m: 1, a: 0, n: 1 },
            timing: 'after_meal',
            durationDays: 5,
            instructionEn: 'With water',
            instructionUr: 'پانی کے ساتھ',
          },
        }),
      ]).sections;
      const stored = start.medicines[0];

      const { sections } = run(
        [op({ op: 'update', section: 'medicines', itemId: stored.id, value: { strength: '650 mg' } })],
        start,
      );

      expect(sections.medicines[0]).toEqual({ ...stored, strength: '650 mg' });
    });

    test('a diagnosis keeps its code when only the text changes', () => {
      const start = run([op({ op: 'add', section: 'diagnosis', value: { text: 'Dengue', code: 'A90' } })]).sections;
      const stored = start.diagnosis[0];

      const { sections } = run(
        [op({ op: 'update', section: 'diagnosis', itemId: stored.id, value: { text: 'Dengue fever' } })],
        start,
      );

      expect(sections.diagnosis[0]).toEqual({ ...stored, text: 'Dengue fever' });
      expect(sections.diagnosis[0].code).toBe('A90');
    });

    test('a text item keeps its source spans when only the text changes', () => {
      const start = run([
        op({ op: 'add', section: 'complaints', value: { text: 'Bukhar' }, spanIds: ['span-1', 'span-2'] }),
      ]).sections;
      const stored = start.complaints[0];

      const { sections } = run(
        [op({ op: 'update', section: 'complaints', itemId: stored.id, value: { text: 'Bukhar, teen din' } })],
        start,
      );

      expect(sections.complaints[0].sourceSpanIds).toEqual(['span-1', 'span-2']);
      expect(sections.complaints[0].text).toBe('Bukhar, teen din');
    });

    test('setting bookByAssistant does not wipe the follow-up', () => {
      const start = run([
        op({
          op: 'update',
          section: 'followUp',
          value: { inDays: 14, date: '2026-12-01', note: 'if the fever returns' },
        }),
      ]).sections;

      const { sections } = run([op({ op: 'update', section: 'followUp', value: { bookByAssistant: false } })], start);

      expect(sections.followUp).toEqual({
        inDays: 14,
        date: '2026-12-01',
        note: 'if the fever returns',
        bookByAssistant: false,
      });
    });

    test('a null sent on purpose still clears the field', () => {
      const start = run([op({ op: 'update', section: 'followUp', value: { inDays: 14, note: 'come back' } })]).sections;

      const { sections } = run([op({ op: 'update', section: 'followUp', value: { inDays: null } })], start);

      // Absent means "leave it"; null means "clear it", and the two must not
      // be the same thing.
      expect(sections.followUp.inDays).toBeNull();
      expect(sections.followUp.note).toBe('come back');
    });

    test('an update that sends nothing usable is refused rather than silently doing nothing', () => {
      const start = run([op({ op: 'add', section: 'advice', value: { text: 'Rest' } })]).sections;
      const itemId = start.advice[0].id;

      expect(() => run([op({ op: 'update', section: 'advice', itemId, value: {} })], start)).toThrow(
        /nothing in that value to change/,
      );
      // An unknown field is stripped by the schema, so it counts as nothing.
      expect(() => run([op({ op: 'update', section: 'advice', itemId, value: { colour: 'red' } })], start)).toThrow(
        /nothing in that value to change/,
      );
    });

    test('a value that is not an object is refused', () => {
      const start = run([op({ op: 'add', section: 'advice', value: { text: 'Rest' } })]).sections;
      const itemId = start.advice[0].id;

      expect(() => run([op({ op: 'update', section: 'advice', itemId, value: 'Rest more' })], start)).toThrow(
        /must be an object/,
      );
    });

    test('an add still fills in the defaults', () => {
      const { sections } = run([op({ op: 'add', section: 'medicines', value: { name: 'Panadol' } })]);
      expect(sections.medicines[0]).toMatchObject({
        form: 'tab',
        route: 'oral',
        pattern: { m: 1, a: 0, n: 0 },
        timing: 'any',
        durationDays: 0,
      });
    });
  });

  describe('followUp', () => {
    test('can only be updated', () => {
      expect(() => run([op({ op: 'add', section: 'followUp', value: { inDays: 7 } })])).toThrow(/can only be updated/);
      expect(() => run([op({ op: 'remove', section: 'followUp' })])).toThrow(/can only be updated/);

      const { sections } = run([op({ op: 'update', section: 'followUp', value: { inDays: 7 } })]);
      expect(sections.followUp).toMatchObject({ inDays: 7, date: null, note: '' });
    });
  });

  describe('a batch is all or nothing', () => {
    /**
     * The reason validation is a separate pass. A bad op halfway through must
     * not leave a prescription half edited.
     */
    test('one bad op discards the whole batch', () => {
      const ops = [
        op({ op: 'add', section: 'complaints', value: { text: 'First' } }),
        op({ op: 'add', section: 'complaints', value: { text: 'Second' } }),
        op({ op: 'update', section: 'complaints', itemId: 'ghost', value: { text: 'Third' } }),
      ];

      expect(() => run(ops)).toThrow(AppError);

      // The sections handed in are untouched, so the caller still holds what it
      // had before it asked.
      const start = empty();
      expect(() => applyOps(start, ops, { actorId, origin: 'typed' })).toThrow();
      expect(start.complaints).toHaveLength(0);
    });

    test('an op that adds and a later one that updates the addition both validate', () => {
      const normalized = validateOps(empty(), [
        op({ op: 'add', section: 'labs', value: { text: 'CBC' } }),
        op({ op: 'add', section: 'labs', value: { text: 'LFT' } }),
      ]);
      expect(normalized).toHaveLength(2);
    });

    test('the error says which op was wrong', () => {
      const thrown = (() => {
        try {
          run([
            op({ op: 'add', section: 'advice', value: { text: 'Rest' } }),
            op({ op: 'add', section: 'medicines', value: {} }),
          ]);
          return null;
        } catch (error) {
          return error as AppError;
        }
      })();

      expect(thrown).toBeInstanceOf(AppError);
      expect(thrown!.code).toBe('OP_INVALID');
      expect(thrown!.message).toContain('op 1');
      expect((thrown!.details as { index: number }).index).toBe(1);
    });
  });

  describe('typed and dictated edits are told apart', () => {
    test('a typed change is recorded in the edit log', () => {
      const { editLog } = run([op({ op: 'add', section: 'complaints', value: { text: 'Bukhar' } })]);
      expect(editLog).toHaveLength(1);
      expect(editLog[0]).toMatchObject({ section: 'complaints', by: String(actorId), from: null });
    });

    test('a dictated change is not, because it is not a correction', () => {
      const { editLog } = run([op({ op: 'add', section: 'complaints', value: { text: 'Bukhar' } })], empty(), 'voice');
      expect(editLog).toHaveLength(0);
    });

    test('a dictated correction over a medicine marks the line', () => {
      const start = run([op({ op: 'add', section: 'medicines', value: { name: 'Panadol' } })], empty(), 'voice').sections;
      const itemId = start.medicines[0].id;

      const { sections } = run(
        [op({ op: 'update', section: 'medicines', itemId, value: { durationDays: 5 } })],
        start,
        'voice',
      );
      expect(sections.medicines[0].correctedBySpeech).toBe(true);
    });

    test('a typed correction over a medicine clears the pipeline flags', () => {
      const start = run(
        [op({ op: 'add', section: 'medicines', value: { name: 'Panadol', flags: ['dose_unclear'] } })],
        empty(),
        'voice',
      ).sections;
      const itemId = start.medicines[0].id;

      const { sections } = run([op({ op: 'update', section: 'medicines', itemId, value: { durationDays: 5 } })], start);
      expect(sections.medicines[0].flags).toEqual([]);
      expect(sections.medicines[0].correctedBySpeech).toBe(false);
    });
  });

  describe('helpers', () => {
    test('isEmpty knows whether there is anything to print', () => {
      expect(isEmpty(empty())).toBe(true);
      expect(isEmpty(run([op({ op: 'add', section: 'advice', value: { text: 'Rest' } })]).sections)).toBe(false);
      expect(isEmpty(run([op({ op: 'update', section: 'followUp', value: { inDays: 3 } })]).sections)).toBe(false);
    });

    test('wireSections fills in a section a stored document predates', () => {
      const sections = wireSections({ complaints: [{ id: 'a1', text: 'Bukhar', sourceSpanIds: [] }] });
      expect(sections.medicines).toEqual([]);
      // bookByAssistant included: a prescription stored before the tick box
      // existed reads as the default it would have been given.
      expect(sections.followUp).toEqual({ inDays: null, date: null, note: '', bookByAssistant: true });
    });
  });
});
