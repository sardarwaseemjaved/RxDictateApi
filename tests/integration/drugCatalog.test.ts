import { readFileSync } from 'fs';
import { join } from 'path';
import { Types } from 'mongoose';
import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, aPlatformAdmin, headersFor, signIn, type SignedIn } from '../fixtures/clinic.fixture';
import { AuditLog, Drug, DrugList, DrugUsage, Prescription, syncCollections } from '../../src/models';
import { formFromFile, importDrugs } from '../../src/services/drugImport.service';
import { migrateTypedDrugs } from '../../src/services/drugMigration.service';
import { parseCsv } from '../../src/utils/csv';

setupTestDB();
jest.setTimeout(30_000);

const FIXTURE = readFileSync(join(__dirname, '../fixtures/drugs.csv'), 'utf8');

const HEADER = 'registrationNo,brand,composition,strength,form,pack,company';

const national = async () => Drug.find({ scope: 'national' }).sort({ drapRegNo: 1 }).lean();

/** Everything the scripts could have changed, for comparing one run with the next. */
const snapshot = async () => {
  const [drugs, lists, usage] = await Promise.all([
    Drug.find().sort({ _id: 1 }).lean(),
    DrugList.find().sort({ _id: 1 }).lean(),
    DrugUsage.find().sort({ _id: 1 }).lean(),
  ]);
  return JSON.stringify({ drugs, lists, usage });
};

describe('The national catalog', () => {
  describe('yarn drugs:import', () => {
    test('the fixture inserts, a second run updates without duplicates', async () => {
      const first = await importDrugs(FIXTURE);
      expect(first).toMatchObject({ dryRun: false, inserted: 7, updated: 0, discontinued: 0 });
      expect(await Drug.countDocuments()).toBe(7);

      const risek = await Drug.findOne({ drapRegNo: '002001' }).lean();
      expect(risek).toMatchObject({
        brand: 'Risek',
        generic: 'Omeprazole 20mg, delayed release',
        strength: '20mg',
        form: 'cap',
        pack: '14',
        company: 'Getz',
        scope: 'national',
        source: 'drapImport',
        status: 'active',
        practiceId: null,
        ownerId: null,
      });

      const second = await importDrugs(FIXTURE);
      expect(second).toMatchObject({ inserted: 0, updated: 7, discontinued: 0 });
      expect(await Drug.countDocuments()).toBe(7);
    });

    test('a known registration number is updated, and its aliases and id stay', async () => {
      await importDrugs(`${HEADER}\nA1,Panadol,Paracetamol 500mg,500mg,Tablet,10x10,GSK`);
      const before = await Drug.findOne({ drapRegNo: 'A1' });
      await Drug.updateOne({ _id: before!._id }, { $set: { aliases: ['panadole'] } });

      await importDrugs(`${HEADER}\nA1,Panadol Forte,Paracetamol 1g,1g,Tablet,10x10,GSK`);

      const after = await Drug.findOne({ drapRegNo: 'A1' }).lean();
      expect(after?._id).toEqual(before!._id);
      expect(after).toMatchObject({ brand: 'Panadol Forte', strength: '1g', aliases: ['panadole'] });
      expect(after?.nameKeys).toEqual(expect.arrayContaining(['panadol forte', 'panadol forte 1g', 'panadole']));
    });

    test('a bad row is skipped with the reason', async () => {
      const { skipped } = await importDrugs(FIXTURE);
      expect(skipped.map(({ registrationNo, reason }) => [registrationNo, reason])).toEqual([
        ['', 'no registration number'],
        ['004001', 'no brand'],
        ['001234', 'this registration number is already in the file'],
      ]);
      expect((await Drug.findOne({ drapRegNo: '001234' }))?.brand).toBe('Panadol');
    });

    test('forms map onto ours, and anything unknown becomes other', async () => {
      await importDrugs(FIXTURE);
      expect((await national()).map((drug) => [drug.brand, drug.form])).toEqual([
        ['Panadol', 'tab'],
        ['Panadol Extra', 'tab'],
        ['Risek', 'cap'],
        ['Augmentin', 'tab'],
        ['Calpol', 'syp'],
        ['Ceftriax', 'inj'],
        ['Skin Soother', 'other'],
      ]);

      expect(formFromFile('Suspension for Injection')).toBe('inj');
      expect(formFromFile('Eye Drops')).toBe('drops');
      expect(formFromFile('Dry Suspension')).toBe('syp');
      expect(formFromFile('Capable of nothing')).toBe('other');
      expect(formFromFile('')).toBe('other');
    });

    test('--discontinue-missing discontinues what the file left out, and only then', async () => {
      await importDrugs(FIXTURE);

      const without = await importDrugs(`${HEADER}\n001234,Panadol,Paracetamol 500mg,500mg,Tablet,10x10,GSK`);
      expect(without.discontinued).toBe(0);
      expect(await Drug.countDocuments({ status: 'active' })).toBe(7);

      const withIt = await importDrugs(`${HEADER}\n001234,Panadol,Paracetamol 500mg,500mg,Tablet,10x10,GSK`, {
        discontinueMissing: true,
      });
      expect(withIt.discontinued).toBe(6);
      expect(await Drug.countDocuments({ status: 'active' })).toBe(1);

      // Back in a later file, it comes back.
      await importDrugs(FIXTURE);
      expect(await Drug.countDocuments({ status: 'active' })).toBe(7);
    });

    test('--discontinue-missing leaves alone a clinic row, and a product whose row in the file was bad', async () => {
      await importDrugs(`${HEADER}\nA1,Panadol,,500mg,Tablet,,\nA2,Risek,,20mg,Capsule,,`);
      const { doctor } = await aClinic('+923013330001');
      await request(app).post('/api/v1/drugs').set(headersFor(doctor)).send({ brand: 'Local', for: 'clinic' }).expect(201);

      // A2's row has lost its brand: that is a bad line, not a product that has gone.
      await importDrugs(`${HEADER}\nA1,Panadol,,500mg,Tablet,,\nA2,,,20mg,Capsule,,`, { discontinueMissing: true });

      expect((await Drug.findOne({ drapRegNo: 'A2' }))?.status).toBe('active');
      expect((await Drug.findOne({ brand: 'Local' }))?.status).toBe('active');
    });

    test('--dry-run says what would happen and changes nothing', async () => {
      await importDrugs(`${HEADER}\nA1,Old Brand,,1mg,Tablet,,\nZ9,Gone,,1mg,Tablet,,`);
      const before = await snapshot();

      const summary = await importDrugs(`${HEADER}\nA1,New Brand,,1mg,Tablet,,\nA2,Another,,1mg,Tablet,,`, {
        dryRun: true,
        discontinueMissing: true,
      });

      expect(summary).toMatchObject({ dryRun: true, inserted: 1, updated: 1, discontinued: 1 });
      expect(await snapshot()).toBe(before);
    });

    test('a file with nothing usable, or without the columns, is refused and changes nothing', async () => {
      await importDrugs(`${HEADER}\nA1,Panadol,,500mg,Tablet,,`);
      const before = await snapshot();

      await expect(importDrugs(`${HEADER}\n,No number,,1mg,Tablet,,`, { discontinueMissing: true })).rejects.toThrow(
        'Nothing in the file',
      );
      await expect(importDrugs('registrationNo,brand\nA1,Panadol')).rejects.toThrow('composition');
      expect(await snapshot()).toBe(before);
    });

    test('the audit log says the import happened', async () => {
      const admin = await aPlatformAdmin('+923013330002');
      await importDrugs(FIXTURE);

      const entry = await AuditLog.findOne({ action: 'drug.import' }).lean();
      expect(String(entry?.practiceId)).toBe(admin.practiceId);
      expect(entry?.after).toMatchObject({ inserted: 7, updated: 0, skipped: 3 });
    });

    test('the file reader takes quotes, doubled quotes, line endings and a byte order mark', () => {
      expect(parseCsv(`${String.fromCharCode(0xfeff)}a,b\r\n"one, two","say ""hi"""\r\n\r\n,\n"line\nbreak",x`)).toEqual([
        ['a', 'b'],
        ['one, two', 'say "hi"'],
        ['line\nbreak', 'x'],
      ]);
    });
  });

  describe('the type-ahead', () => {
    const stages = (plan: unknown): string[] => {
      const node = plan as { stage?: string; inputStage?: unknown; inputStages?: unknown[]; queryPlan?: unknown };
      const children = [node.queryPlan, node.inputStage, ...(node.inputStages ?? [])].filter(Boolean);
      return [...(node.stage ? [node.stage] : []), ...children.flatMap(stages)];
    };

    test('a prefix search walks the index rather than scanning', async () => {
      await importDrugs(FIXTURE);

      const explained = (await Drug.find({
        scope: 'national',
        status: 'active',
        practiceId: null,
        ownerId: null,
        nameKeys: /^pana/,
      }).explain('queryPlanner')) as unknown as { queryPlanner: { winningPlan: unknown } };

      const plan = stages(explained.queryPlanner.winningPlan);
      expect(plan).toContain('IXSCAN');
      expect(plan).not.toContain('COLLSCAN');
    });

    test('the keys cover brand, generic and aliases, in lower case', async () => {
      await importDrugs(FIXTURE);
      const extra = await Drug.findOne({ drapRegNo: '001235' }).lean();
      expect(extra?.nameKeys).toEqual(
        expect.arrayContaining(['panadol extra', 'paracetamol 500mg + caffeine 65mg', 'panadol extra 500mg']),
      );
      expect(extra?.wordKeys).toEqual(expect.arrayContaining(['caffeine 65mg', 'extra', '65mg']));
    });

    test('the unique indexes: one row per registration number, and per medicine per owner', async () => {
      const owner = new Types.ObjectId();
      const practiceId = new Types.ObjectId();
      const row = (fields: object) => ({
        brand: 'Risek',
        source: 'typed',
        brandKey: 'risek',
        identityKey: 'risek||tab',
        ...fields,
      });

      await Drug.create(row({ scope: 'national', source: 'drapImport', drapRegNo: 'R1' }));
      // The same medicine under another registration number, which is what two packs are.
      await Drug.create(row({ scope: 'national', source: 'drapImport', drapRegNo: 'R2' }));
      await expect(Drug.create(row({ scope: 'national', source: 'drapImport', drapRegNo: 'R1' }))).rejects.toThrow('E11000');

      await Drug.create(row({ scope: 'clinic', source: 'clinic', practiceId }));
      await expect(Drug.create(row({ scope: 'clinic', source: 'clinic', practiceId }))).rejects.toThrow('E11000');

      await Drug.create(row({ scope: 'doctor', practiceId, ownerId: owner }));
      await Drug.create(row({ scope: 'doctor', practiceId, ownerId: new Types.ObjectId() }));
      await expect(Drug.create(row({ scope: 'doctor', practiceId, ownerId: owner }))).rejects.toThrow('E11000');
    });

    test('the index from when the catalog grew from typing is dropped', async () => {
      await Drug.collection.createIndex({ brand: 1, strength: 1, form: 1 }, { unique: true });
      expect(await Drug.collection.indexExists('brand_1_strength_1_form_1')).toBe(true);

      await syncCollections();

      expect(await Drug.collection.indexExists('brand_1_strength_1_form_1')).toBe(false);
    });
  });
});

describe('yarn drugs:migrate-typed', () => {
  /** A row as the old code left it: no scope, and a count nothing reads any more. */
  const typedRow = async (brand: string, strength = '', form = 'tab') => {
    const _id = new Types.ObjectId();
    await Drug.collection.insertOne({
      _id,
      brand,
      generic: '',
      strength,
      form,
      company: 'Typed Co',
      aliases: ['an alias'],
      useCount: 40,
      createdBy: null,
    } as never);
    return _id;
  };

  const prescribed = async (
    doctor: SignedIn,
    drugIds: (Types.ObjectId | null)[],
    { status = 'approved', approvedAt = new Date('2026-06-01T10:00:00Z'), names = [] as string[] } = {},
  ) => {
    const _id = new Types.ObjectId();
    await Prescription.collection.insertOne({
      _id,
      practiceId: new Types.ObjectId(doctor.practiceId),
      locationId: new Types.ObjectId(doctor.locationId),
      patientId: new Types.ObjectId(),
      doctorId: new Types.ObjectId(doctor.userId),
      approvedBy: new Types.ObjectId(doctor.userId),
      approvedAt: status === 'draft' ? null : approvedAt,
      status,
      deletedAt: null,
      createdAt: approvedAt,
      sections: {
        medicines: drugIds.map((drugId, at) => ({
          id: `line-${at}`,
          drugId,
          name: names[at] ?? 'Risek',
          strength: '20mg',
          form: 'cap',
        })),
      },
    } as never);
    return _id;
  };

  const twoDoctors = async () => {
    const { doctor, patientId } = await aClinic('+923013340001');
    await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923013340002', name: 'Dr Second', role: 'doctor', locationIds: [doctor.locationId] })
      .expect(201);
    const second = await signIn('+923013340002');
    return { doctor, second, patientId };
  };

  const listOf = async (doctor: SignedIn) =>
    (await request(app).get('/api/v1/drug-lists/me').set(headersFor(doctor)).expect(200)).body.data;

  test('a row two doctors prescribed becomes one row for each, each on their own list', async () => {
    const { doctor, second } = await twoDoctors();
    const risek = await typedRow('Risek', '20mg', 'cap');
    await prescribed(doctor, [risek]);
    await prescribed(second, [risek]);

    const summary = await migrateTypedDrugs();
    expect(summary).toMatchObject({ typedRows: 1, doctorRows: 2, dropped: [] });

    const rows = await Drug.find({ brand: 'Risek' }).lean();
    expect(rows).toHaveLength(2);
    rows.forEach((row) => {
      expect(row).toMatchObject({
        scope: 'doctor',
        source: 'typed',
        status: 'active',
        strength: '20mg',
        form: 'cap',
        company: 'Typed Co',
        aliases: ['an alias'],
        practiceId: new Types.ObjectId(doctor.practiceId),
      });
    });
    expect(rows.map((row) => String(row.ownerId)).sort()).toEqual([doctor.userId, second.userId].sort());
    expect(await Drug.findById(risek)).toBeNull();

    const [mine, theirs] = await Promise.all([listOf(doctor), listOf(second)]);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0].drug).toMatchObject({ brand: 'Risek', scope: 'doctor', source: 'typed', verified: false });
    expect(mine[0].drug.id).not.toBe(theirs[0].drug.id);
  });

  test('one clinic does not see what the same doctor prescribed at another', async () => {
    const { doctor } = await aClinic('+923013340003');
    const { doctor: other } = await aClinic('+923013340004');
    const risek = await typedRow('Risek', '20mg', 'cap');
    await prescribed(doctor, [risek]);
    await prescribed(other, [risek]);

    await migrateTypedDrugs();

    const rows = await Drug.find({ brand: 'Risek' }).lean();
    expect(rows.map((row) => String(row.practiceId)).sort()).toEqual([doctor.practiceId, other.practiceId].sort());
  });

  test('a row no approved prescription used is dropped, even if a draft or a cancelled one did', async () => {
    const { doctor } = await aClinic('+923013340005');
    const unused = await typedRow('Unused');
    const inDraft = await typedRow('Only A Draft');
    const inCancelled = await typedRow('Only Cancelled');
    await prescribed(doctor, [inDraft], { status: 'draft' });
    await prescribed(doctor, [inCancelled], { status: 'cancelled' });

    const summary = await migrateTypedDrugs();

    expect(summary.doctorRows).toBe(0);
    expect(summary.dropped.map(({ brand }) => brand).sort()).toEqual(['Only A Draft', 'Only Cancelled', 'Unused']);
    expect(await Drug.countDocuments()).toBe(0);
    expect(await Drug.findById(unused)).toBeNull();
  });

  test('usage matches the approved prescriptions: once each, with the last date, and superseded ones count', async () => {
    const { doctor } = await aClinic('+923013340006');
    const risek = await typedRow('Risek', '20mg', 'cap');

    await prescribed(doctor, [risek], { approvedAt: new Date('2026-01-10T10:00:00Z') });
    await prescribed(doctor, [risek], { approvedAt: new Date('2026-03-10T10:00:00Z'), status: 'superseded' });
    // Two lines on one prescription are one use of it.
    await prescribed(doctor, [risek, risek], { approvedAt: new Date('2026-02-10T10:00:00Z') });
    await prescribed(doctor, [risek], { status: 'draft' });

    await migrateTypedDrugs();

    const [row] = await Drug.find({ brand: 'Risek' });
    const usage = await DrugUsage.findOne({ drugId: row._id }).lean();
    expect(usage).toMatchObject({ count: 3, doctorId: new Types.ObjectId(doctor.userId) });
    expect(usage?.lastUsedAt).toEqual(new Date('2026-03-10T10:00:00Z'));
  });

  test('two spellings of one medicine by one doctor become one row, counted once per prescription', async () => {
    const { doctor } = await aClinic('+923013340007');
    const upper = await typedRow('Risek', '20mg', 'cap');
    const lower = await typedRow('risek', '20 mg', 'cap');
    await prescribed(doctor, [upper]);
    await prescribed(doctor, [lower], { names: ['risek'] });
    await prescribed(doctor, [upper, lower]);

    await migrateTypedDrugs();

    const rows = await Drug.find({ scope: 'doctor' });
    expect(rows).toHaveLength(1);
    expect(await Drug.countDocuments({ scope: null })).toBe(0);
    expect((await DrugUsage.findOne({ drugId: rows[0]._id }))?.count).toBe(3);
    expect(await listOf(doctor)).toHaveLength(1);
  });

  test('a second run changes nothing, and a dry run changes nothing either', async () => {
    const { doctor, second } = await twoDoctors();
    const risek = await typedRow('Risek', '20mg', 'cap');
    await typedRow('Unused');
    await prescribed(doctor, [risek]);
    await prescribed(second, [risek]);

    const beforeDryRun = await snapshot();
    const dry = await migrateTypedDrugs({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, typedRows: 2, doctorRows: 2 });
    expect(dry.dropped).toEqual([{ brand: 'Unused', strength: '', form: 'tab' }]);
    expect(await snapshot()).toBe(beforeDryRun);

    await migrateTypedDrugs();
    const once = await snapshot();
    const audits = await AuditLog.countDocuments();

    const again = await migrateTypedDrugs();

    expect(again).toMatchObject({ typedRows: 0, doctorRows: 0, dropped: [] });
    expect(await snapshot()).toBe(once);
    expect(await AuditLog.countDocuments()).toBe(audits);
  });

  test('a run that stopped before deleting goes round again to the same place', async () => {
    const { doctor } = await aClinic('+923013340008');
    const risek = await typedRow('Risek', '20mg', 'cap');
    await prescribed(doctor, [risek]);
    await prescribed(doctor, [risek]);

    const deleteMany = jest.spyOn(Drug, 'deleteMany').mockRejectedValueOnce(new Error('the database went away'));
    await expect(migrateTypedDrugs()).rejects.toThrow('the database went away');
    deleteMany.mockRestore();

    await migrateTypedDrugs();

    expect(await Drug.countDocuments({ brand: 'Risek' })).toBe(1);
    const [row] = await Drug.find({ brand: 'Risek' });
    expect((await DrugUsage.findOne({ drugId: row._id }))?.count).toBe(2);
    expect(await listOf(doctor)).toHaveLength(1);
  });

  test('prescriptions are not touched', async () => {
    const { doctor } = await aClinic('+923013340009');
    const risek = await typedRow('Risek', '20mg', 'cap');
    const id = await prescribed(doctor, [risek]);
    const before = JSON.stringify(await Prescription.collection.findOne({ _id: id }));

    await migrateTypedDrugs();

    expect(JSON.stringify(await Prescription.collection.findOne({ _id: id }))).toBe(before);
  });

  test('a draft line pointing at a dropped row is treated as typed when it is approved', async () => {
    const { doctor, patientId } = await aClinic('+923013340010');
    const headers = headersFor(doctor, { location: true });
    const dropped = await typedRow('Mystery', '5mg', 'tab');

    const draft = await aDraft(doctor, patientId);
    await Prescription.updateOne(
      { _id: draft.id },
      {
        $set: {
          'sections.medicines': [
            { id: 'one', drugId: dropped, name: 'Mystery', strength: '5mg', form: 'tab', pattern: { m: 1, a: 0, n: 0 } },
          ],
        },
      },
    );

    await migrateTypedDrugs();
    expect(await Drug.findById(dropped)).toBeNull();

    const approved = await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);

    const line = approved.body.data.sections.medicines[0];
    expect(line.drugId).not.toBe(String(dropped));
    expect(await Drug.findById(line.drugId).lean()).toMatchObject({ brand: 'Mystery', scope: 'doctor', source: 'typed' });
    expect(await listOf(doctor)).toHaveLength(1);
  });

  test('approved between the release and this script: the count includes it, once', async () => {
    const { doctor, patientId } = await aClinic('+923013340011');
    const headers = headersFor(doctor, { location: true });
    const risek = await typedRow('Risek', '20mg', 'cap');
    await prescribed(doctor, [risek]);

    // The old row cannot be seen any more, so this approval made the doctor's own.
    const draft = await aDraft(doctor, patientId);
    await request(app)
      .patch(`/api/v1/prescriptions/${draft.id}`)
      .set(headers)
      .send({ ops: [{ op: 'add', section: 'medicines', value: { name: 'Risek', strength: '20mg', form: 'cap' } }] })
      .expect(200);
    await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(headers).expect(200);
    expect(await Drug.countDocuments({ scope: 'doctor', brand: 'Risek' })).toBe(1);

    await migrateTypedDrugs();

    expect(await Drug.countDocuments({ brand: 'Risek' })).toBe(1);
    const [row] = await Drug.find({ brand: 'Risek' });
    expect((await DrugUsage.findOne({ drugId: row._id }))?.count).toBe(2);
    expect(await listOf(doctor)).toHaveLength(1);
  });

  test('each doctor gets an audit entry in their clinic, and nothing about them goes on the platform', async () => {
    await aPlatformAdmin('+923013340012');
    const { doctor } = await aClinic('+923013340013');
    await prescribed(doctor, [await typedRow('Risek', '20mg', 'cap')]);

    await migrateTypedDrugs();

    const entries = await AuditLog.find({ action: 'drug.migrateTyped' }).lean();
    expect(entries).toHaveLength(2);
    const inClinic = entries.find((entry) => String(entry.practiceId) === doctor.practiceId);
    expect(String(inClinic?.actorId)).toBe(doctor.userId);
    const onPlatform = entries.find((entry) => String(entry.practiceId) !== doctor.practiceId);
    expect(onPlatform?.after).toMatchObject({ typedRows: 1, doctorRows: 1, dropped: [] });
    expect(JSON.stringify(onPlatform?.after)).not.toContain(doctor.userId);
  });
});
