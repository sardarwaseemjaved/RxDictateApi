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
      expect(sections.followUp).toEqual({ inDays: null, date: null, note: '' });
    });
  });
});
