import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, aPa, headersFor, pause, signIn, type SignedIn } from '../fixtures/clinic.fixture';
import { signedIn, startLive, type Live, type LiveClient } from '../fixtures/realtime.fixture';
import { AuditLog, Drug, DrugList, DrugUsage } from '../../src/models';
import { importDrugs } from '../../src/services/drugImport.service';
import { SETTINGS } from '../../src/shared/settings';
import { actionsFor } from '../../src/core/permissions';

setupTestDB();
jest.setTimeout(60_000);

const HEADER = 'registrationNo,brand,composition,strength,form,pack,company';

/** National rows, by brand: `Brand` or `Brand|generic`. Each gets a registration number of its own. */
const catalog = async (...brands: string[]) => {
  const lines = brands.map((entry, at) => {
    const [brand, generic = ''] = entry.split('|');
    return `R${at + 1},${brand},${generic},,Tablet,10x10,Acme`;
  });
  await importDrugs([HEADER, ...lines].join('\n'));
};

const idOf = async (brand: string): Promise<string> => String((await Drug.findOne({ brand }))!._id);

const suggest = async (actor: SignedIn, q: string, extra: Record<string, string> = {}) =>
  (
    await request(app)
      .get('/api/v1/drugs')
      .query({ q, ...extra })
      .set(headersFor(actor))
      .expect(200)
  ).body.data;

const brands = (results: { brand: string }[]): string[] => results.map((drug) => drug.brand);

const setMode = async (actor: SignedIn, value: string) =>
  request(app)
    .patch('/api/v1/settings/me')
    .set(headersFor(actor))
    .send({ values: [{ key: 'medicines.source', value }] })
    .expect(200);

const put = (actor: SignedIn, owner: string, drugId: string, body: object = {}) =>
  request(app).put(`/api/v1/drug-lists/${owner}/items/${drugId}`).set(headersFor(actor)).send(body);

const take = (actor: SignedIn, owner: string, drugId: string) =>
  request(app).delete(`/api/v1/drug-lists/${owner}/items/${drugId}`).set(headersFor(actor));

const list = async (actor: SignedIn, owner: string, query: object = {}) =>
  request(app).get(`/api/v1/drug-lists/${owner}`).query(query).set(headersFor(actor)).expect(200);

const addOwn = (actor: SignedIn, body: object) => request(app).post('/api/v1/drugs').set(headersFor(actor)).send(body);

const lineFor = (name: string, drugId: string | null = null, strength = '', form = 'tab') => ({
  op: 'add',
  section: 'medicines',
  value: { name, strength, form, ...(drugId ? { drugId } : {}) },
});

/** A draft with these lines on it, saved. */
const drafted = async (doctor: SignedIn, patientId: string, lines: object[]) => {
  const draft = await aDraft(doctor, patientId);
  const saved = await request(app)
    .patch(`/api/v1/prescriptions/${draft.id}`)
    .set(headersFor(doctor, { location: true }))
    .send({ ops: lines })
    .expect(200);
  return saved.body.data;
};

const approve = async (doctor: SignedIn, id: string) =>
  (
    await request(app)
      .post(`/api/v1/prescriptions/${id}/approve`)
      .set(headersFor(doctor, { location: true }))
      .expect(200)
  ).body.data;

/** Prescribe and sign, which is what puts a drug in this doctor's use. */
const prescribe = async (doctor: SignedIn, patientId: string, ...lines: object[]) =>
  approve(doctor, (await drafted(doctor, patientId, lines)).id);

/** A second doctor in the same clinic, signed in. */
const aSecondDoctor = async (doctor: SignedIn, phone: string): Promise<SignedIn> => {
  await request(app)
    .post('/api/v1/members')
    .set(headersFor(doctor))
    .send({ phone, name: 'Dr Second', role: 'doctor', locationIds: [doctor.locationId] })
    .expect(201);
  return signIn(phone);
};

const aManager = async (doctor: SignedIn, phone: string): Promise<SignedIn> => {
  await request(app)
    .post('/api/v1/members')
    .set(headersFor(doctor))
    .send({ phone, name: 'Hina', role: 'medicineManager' })
    .expect(201);
  return signIn(phone);
};

describe('Suggestions', () => {
  /**
   * A doctor's list, a clinic's list, a clinic's own item, some use, and the rest:
   *
   *   Para Gamma    on the doctor's list
   *   Zed Para      on the doctor's list, and only contains what is typed
   *   Para Beta     on the clinic's list, prescribed once
   *   Para Local    the clinic's own item, on its list
   *   Para Delta    on no list, prescribed twice
   *   Para Alpha    on no list, never prescribed
   */
  const arrange = async (phone: string) => {
    const { doctor, patientId } = await aClinic(phone);
    await catalog('Para Alpha', 'Para Beta', 'Para Delta', 'Para Gamma', 'Zed Para', 'Unrelated');

    await put(doctor, 'me', await idOf('Para Gamma')).expect(200);
    await put(doctor, 'me', await idOf('Zed Para')).expect(200);
    await put(doctor, 'clinic', await idOf('Para Beta')).expect(200);
    await addOwn(doctor, { brand: 'Para Local', for: 'clinic' }).expect(201);

    await prescribe(doctor, patientId, lineFor('Para Delta', await idOf('Para Delta')));
    await prescribe(doctor, patientId, lineFor('Para Delta', await idOf('Para Delta')));
    await prescribe(doctor, patientId, lineFor('Para Beta', await idOf('Para Beta')));

    return { doctor, patientId };
  };

  test("myListFirst, the default: the doctor's list, then the clinic's, then the rest", async () => {
    const { doctor } = await arrange('+923014440001');

    expect(brands(await suggest(doctor, 'para'))).toEqual([
      'Para Gamma',
      'Zed Para',
      'Para Beta',
      'Para Local',
      // In the rest, what this doctor has used comes before what they have not.
      'Para Delta',
      'Para Alpha',
    ]);
  });

  test('myList: only the two lists, what the doctor has used first', async () => {
    const { doctor } = await arrange('+923014440002');
    await setMode(doctor, 'myList');

    expect(brands(await suggest(doctor, 'para'))).toEqual(['Para Beta', 'Para Gamma', 'Para Local', 'Zed Para']);
  });

  test("all: the doctor's list, then their use, then the clinic's, then the rest", async () => {
    const { doctor } = await arrange('+923014440003');
    await setMode(doctor, 'all');

    expect(brands(await suggest(doctor, 'para'))).toEqual([
      'Para Gamma',
      'Zed Para',
      'Para Delta',
      'Para Beta',
      'Para Local',
      'Para Alpha',
    ]);
  });

  test('everywhere=true searches as all for that request and never changes the setting', async () => {
    const { doctor } = await arrange('+923014440004');
    await setMode(doctor, 'myList');

    expect(brands(await suggest(doctor, 'para', { everywhere: 'true' }))).toEqual([
      'Para Gamma',
      'Zed Para',
      'Para Delta',
      'Para Beta',
      'Para Local',
      'Para Alpha',
    ]);

    const settings = await request(app).get('/api/v1/settings').set(headersFor(doctor)).expect(200);
    expect(settings.body.data['medicines.source'].value).toBe('myList');
  });

  test('everywhere=false really means false, and anything else is refused', async () => {
    const { doctor } = await arrange('+923014440005');
    await setMode(doctor, 'myList');

    expect(brands(await suggest(doctor, 'para', { everywhere: 'false' }))).not.toContain('Para Alpha');

    const refused = await request(app)
      .get('/api/v1/drugs')
      .query({ q: 'para', everywhere: 'perhaps' })
      .set(headersFor(doctor))
      .expect(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('the mode comes from the clinic when the doctor has not chosen', async () => {
    const { doctor } = await arrange('+923014440006');
    await request(app)
      .patch('/api/v1/settings/organisation')
      .set(headersFor(doctor))
      .send({ values: [{ key: 'medicines.source', value: 'myList' }] })
      .expect(200);

    expect(brands(await suggest(doctor, 'para'))).not.toContain('Para Alpha');
  });

  test('inside a tier: a name that starts with what was typed, then one that contains it, then use, then the alphabet', async () => {
    const { doctor, patientId } = await aClinic('+923014440007');
    await catalog('Calpol|Paracetamol 120mg', 'Mol Para', 'Paracet', 'Panadol|Paracetamol 500mg', 'Zebra Para');

    await prescribe(doctor, patientId, lineFor('Zebra Para', await idOf('Zebra Para')));
    await prescribe(doctor, patientId, lineFor('Panadol', await idOf('Panadol')));

    // Every one of these is in the rest. A generic that starts with it counts as a name that does.
    expect(brands(await suggest(doctor, 'para', { limit: '10' }))).toEqual([
      'Panadol',
      'Calpol',
      'Paracet',
      'Zebra Para',
      'Mol Para',
    ]);
  });

  test('what is typed is matched without regard to case or spacing, and "panadol 500" still finds it', async () => {
    const { doctor } = await aClinic('+923014440008');
    await importDrugs(`${HEADER}\nR1,Panadol,Paracetamol 500mg + Caffeine 65mg,500mg,Tablet,10x10,GSK`);

    expect(brands(await suggest(doctor, 'PANA'))).toEqual(['Panadol']);
    expect(brands(await suggest(doctor, '  panadol   500'))).toEqual(['Panadol']);
    expect(brands(await suggest(doctor, 'caffeine'))).toEqual(['Panadol']);
    // Characters a regex would read as syntax are only characters.
    expect(await suggest(doctor, 'pana.*')).toEqual([]);
  });

  test("another clinic's items and another doctor's typed rows never appear, in any mode", async () => {
    const { doctor, patientId } = await aClinic('+923014440009');
    const colleague = await aSecondDoctor(doctor, '+923014440010');
    const { doctor: stranger, patientId: theirPatient } = await aClinic('+923014440011');

    await addOwn(stranger, { brand: 'Secret Clinic Item', for: 'clinic' }).expect(201);
    await prescribe(stranger, theirPatient, lineFor('Secret Typed Abroad'));
    await prescribe(colleague, patientId, lineFor('Secret Typed Here'));
    await addOwn(colleague, { brand: 'Secret Own', for: 'me' }).expect(201);

    await ['myList', 'myListFirst', 'all'].reduce(async (previous, mode) => {
      await previous;
      await setMode(doctor, mode);
      expect(await suggest(doctor, 'secret')).toEqual([]);
      expect(await suggest(doctor, 'secret', { everywhere: 'true' })).toEqual([]);
    }, Promise.resolve());

    // And it is still there for the one it belongs to.
    expect(brands(await suggest(colleague, 'secret')).sort()).toEqual(['Secret Own', 'Secret Typed Here']);
  });

  test('a discontinued drug never appears, wherever it is', async () => {
    const { doctor } = await aClinic('+923014440012');
    await catalog('Old Faithful', 'Old Friend');
    await put(doctor, 'me', await idOf('Old Faithful')).expect(200);
    await importDrugs(`${HEADER}\nR2,Old Friend,,,Tablet,10x10,Acme`, { discontinueMissing: true });

    await ['myList', 'myListFirst', 'all'].reduce(async (previous, mode) => {
      await previous;
      await setMode(doctor, mode);
      expect(brands(await suggest(doctor, 'old', { everywhere: mode === 'all' ? 'true' : 'false' }))).not.toContain(
        'Old Faithful',
      );
    }, Promise.resolve());
  });

  test("a doctor's typed row is found through their list, so one they took off stays off", async () => {
    const { doctor } = await aClinic('+923014440013');
    const added = await addOwn(doctor, { brand: 'Typo Row', for: 'me' }).expect(201);

    expect(brands(await suggest(doctor, 'typo'))).toEqual(['Typo Row']);

    await take(doctor, 'me', added.body.data.drug.id).expect(200);

    expect(await suggest(doctor, 'typo')).toEqual([]);
    expect(await suggest(doctor, 'typo', { everywhere: 'true' })).toEqual([]);
  });

  test("each result says where it is, and its usual comes from the doctor's list, then the clinic's", async () => {
    const { doctor } = await aClinic('+923014440014');
    await catalog('Both', 'Clinic Only', 'Neither', 'Mine Blank');
    const clinicUsual = { durationDays: 3 };
    const myUsual = { durationDays: 7, timing: 'after_meal' };

    await put(doctor, 'me', await idOf('Both'), { usual: myUsual }).expect(200);
    await put(doctor, 'clinic', await idOf('Both'), { usual: clinicUsual }).expect(200);
    await put(doctor, 'clinic', await idOf('Clinic Only'), { usual: clinicUsual }).expect(200);
    await put(doctor, 'me', await idOf('Mine Blank')).expect(200);
    await put(doctor, 'clinic', await idOf('Mine Blank'), { usual: clinicUsual }).expect(200);

    const [both] = await suggest(doctor, 'both');
    expect(both).toMatchObject({ inMyList: true, inClinicList: true, usual: myUsual });
    const [clinicOnly] = await suggest(doctor, 'clinic');
    expect(clinicOnly).toMatchObject({ inMyList: false, inClinicList: true, usual: clinicUsual });
    const [neither] = await suggest(doctor, 'neither');
    expect(neither).toMatchObject({ inMyList: false, inClinicList: false, usual: null });
    const [blank] = await suggest(doctor, 'mine');
    expect(blank).toMatchObject({ inMyList: true, inClinicList: true, usual: clinicUsual });
  });

  test('every field GET /drugs returned before is still there, and the new ones with it', async () => {
    const { doctor } = await aClinic('+923014440015');
    await importDrugs(`${HEADER}\nDRAP-1,Panadol,Paracetamol 500mg,500mg,Tablet,10x10,GSK`);

    const [drug] = await suggest(doctor, 'panadol');

    expect(drug).toEqual({
      id: await idOf('Panadol'),
      brand: 'Panadol',
      generic: 'Paracetamol 500mg',
      strength: '500mg',
      form: 'tab',
      company: 'GSK',
      aliases: [],
      pack: '10x10',
      drapRegNo: 'DRAP-1',
      scope: 'national',
      source: 'drapImport',
      status: 'active',
      verified: true,
      inMyList: false,
      inClinicList: false,
      usual: null,
    });
  });

  test('limit is respected, across the tiers', async () => {
    const { doctor } = await aClinic('+923014440016');
    await catalog('Cold A', 'Cold B', 'Cold C', 'Cold D');
    await put(doctor, 'me', await idOf('Cold D')).expect(200);

    expect(brands(await suggest(doctor, 'cold', { limit: '2' }))).toEqual(['Cold D', 'Cold A']);
  });
});

describe('Lists', () => {
  test.each(['me', 'clinic'])('%s: add, update the usual, and remove', async (owner) => {
    const { doctor } = await aClinic(owner === 'me' ? '+923015550001' : '+923015550002');
    await catalog('Panadol');
    const id = await idOf('Panadol');

    const added = await put(doctor, owner, id).expect(200);
    expect(added.body.data).toMatchObject({ drug: { id, brand: 'Panadol' }, usual: null });
    expect(added.body.data.addedAt).toEqual(expect.any(String));

    const usual = {
      pattern: { m: 1, a: 0, n: 1 },
      timing: 'after_meal',
      durationDays: 5,
      instructionEn: 'With water',
      instructionUr: 'پانی کے ساتھ',
    };
    const updated = await put(doctor, owner, id, { usual }).expect(200);
    expect(updated.body.data.usual).toEqual(usual);
    expect(updated.body.data.addedAt).toBe(added.body.data.addedAt);

    // Leaving it out keeps it, and null takes it away.
    expect((await put(doctor, owner, id).expect(200)).body.data.usual).toEqual(usual);
    expect((await put(doctor, owner, id, { usual: null }).expect(200)).body.data.usual).toBeNull();

    const page = await list(doctor, owner);
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });

    expect((await take(doctor, owner, id).expect(200)).body.data).toEqual({ removed: true });
    expect((await list(doctor, owner)).body.data).toEqual([]);

    // The catalog keeps it.
    expect(await Drug.findById(id)).not.toBeNull();
  });

  test('a usual keeps only what was said: no dose is invented', async () => {
    const { doctor } = await aClinic('+923015550003');
    await catalog('Panadol');

    const { body } = await put(doctor, 'me', await idOf('Panadol'), { usual: { durationDays: 5 } }).expect(200);

    expect(body.data.usual).toEqual({ durationDays: 5 });
  });

  test('a bad usual is refused, in the same terms as a medicine line', async () => {
    const { doctor } = await aClinic('+923015550004');
    await catalog('Panadol');

    const refused = await put(doctor, 'me', await idOf('Panadol'), { usual: { timing: 'whenever' } }).expect(400);

    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('sending it twice changes nothing and writes nothing', async () => {
    const { doctor } = await aClinic('+923015550005');
    await catalog('Panadol');
    const id = await idOf('Panadol');
    const usual = { durationDays: 5 };

    await put(doctor, 'me', id, { usual }).expect(200);
    const audits = await AuditLog.countDocuments({ entity: 'drug' });
    const [before] = await DrugList.find().lean();

    await put(doctor, 'me', id, { usual }).expect(200);

    expect(await AuditLog.countDocuments({ entity: 'drug' })).toBe(audits);
    const [after] = await DrugList.find().lean();
    expect(after.items).toEqual(before.items);
    expect(after.items).toHaveLength(1);
  });

  test('taking off what is not there is already done, and writes nothing', async () => {
    const { doctor } = await aClinic('+923015550006');
    await catalog('Panadol');
    const audits = await AuditLog.countDocuments({ entity: 'drug' });

    const { body } = await take(doctor, 'me', await idOf('Panadol')).expect(200);

    expect(body.data).toEqual({ removed: false });
    expect(await AuditLog.countDocuments({ entity: 'drug' })).toBe(audits);
  });

  test('each write is audited, with who and which list', async () => {
    const { doctor } = await aClinic('+923015550007');
    await catalog('Panadol');
    const id = await idOf('Panadol');

    await put(doctor, 'clinic', id).expect(200);
    await put(doctor, 'clinic', id, { usual: { durationDays: 2 } }).expect(200);
    await take(doctor, 'clinic', id).expect(200);

    const entries = await AuditLog.find({ entity: 'drug' }).sort({ _id: 1 }).lean();
    expect(entries.map((entry) => entry.action)).toEqual(['drugList.add', 'drugList.update', 'drugList.remove']);
    expect(entries[1]).toMatchObject({
      before: { owner: 'clinic', usual: null },
      after: { owner: 'clinic', usual: { durationDays: 2 } },
    });
    entries.forEach((entry) => expect(String(entry.actorId)).toBe(doctor.userId));
  });

  test('a page is by brand, and q narrows it', async () => {
    const { doctor } = await aClinic('+923015550008');
    await catalog('Zinc', 'Amoxil', 'Panadol|Paracetamol 500mg');
    await put(doctor, 'me', await idOf('Zinc')).expect(200);
    await put(doctor, 'me', await idOf('Panadol')).expect(200);
    await put(doctor, 'me', await idOf('Amoxil')).expect(200);

    const all = await list(doctor, 'me');
    expect(all.body.data.map((item: { drug: { brand: string } }) => item.drug.brand)).toEqual(['Amoxil', 'Panadol', 'Zinc']);

    const first = await list(doctor, 'me', { limit: 2, page: 2 });
    expect(first.body.data.map((item: { drug: { brand: string } }) => item.drug.brand)).toEqual(['Zinc']);
    expect(first.body.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });

    const found = await list(doctor, 'me', { q: 'parac' });
    expect(found.body.data.map((item: { drug: { brand: string } }) => item.drug.brand)).toEqual(['Panadol']);
  });

  test('a discontinued drug stays listed, shown as discontinued, can be taken off, and is not suggested', async () => {
    const { doctor } = await aClinic('+923015550009');
    await catalog('Old Faithful', 'Keeper');
    const id = await idOf('Old Faithful');
    await put(doctor, 'me', id, { usual: { durationDays: 3 } }).expect(200);

    await importDrugs(`${HEADER}\nR2,Keeper,,,Tablet,10x10,Acme`, { discontinueMissing: true });

    const page = await list(doctor, 'me');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.data[0].drug).toMatchObject({ id, status: 'discontinued' });
    expect(await suggest(doctor, 'old')).toEqual([]);

    // What it says about it can still be changed, and sending the same again is still fine.
    await put(doctor, 'me', id, { usual: { durationDays: 3 } }).expect(200);
    await take(doctor, 'me', id).expect(200);
    expect((await list(doctor, 'me')).body.data).toEqual([]);
  });

  test('what may go on a list', async () => {
    const { doctor, patientId } = await aClinic('+923015550010');
    const { doctor: stranger } = await aClinic('+923015550011');
    const colleague = await aSecondDoctor(doctor, '+923015550012');
    await catalog('Gone', 'Keeper');
    await importDrugs(`${HEADER}\nR2,Keeper,,,Tablet,10x10,Acme`, { discontinueMissing: true });

    const discontinued = await put(doctor, 'me', await idOf('Gone')).expect(400);
    expect(discontinued.body.error.details).toEqual([{ field: 'params.drugId', message: 'has been discontinued' }]);

    // The clinic's own items on either list.
    const clinicItem = (await addOwn(doctor, { brand: 'Local', for: 'clinic' }).expect(201)).body.data.drug.id;
    await put(doctor, 'me', clinicItem).expect(200);

    // A doctor's own typed row on their own list, and never on the clinic's.
    const typed = await prescribe(doctor, patientId, lineFor('My Typed'));
    const typedId = typed.sections.medicines[0].drugId;
    await put(doctor, 'me', typedId).expect(200);
    const onClinic = await put(doctor, 'clinic', typedId).expect(400);
    expect(onClinic.body.error.code).toBe('VALIDATION_ERROR');

    // What they cannot see is simply not found.
    const theirs = (await addOwn(stranger, { brand: 'Their Local', for: 'clinic' }).expect(201)).body.data.drug.id;
    expect((await put(doctor, 'me', theirs).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await put(colleague, 'me', typedId).expect(404)).body.error.code).toBe('NOT_FOUND');
    await put(doctor, 'me', '6540000000000000000000aa').expect(404);
  });

  test("a doctor cannot touch another doctor's list", async () => {
    const { doctor } = await aClinic('+923015550013');
    const colleague = await aSecondDoctor(doctor, '+923015550014');
    await catalog('Panadol');
    const id = await idOf('Panadol');
    await put(doctor, 'me', id, { usual: { durationDays: 9 } }).expect(200);

    // There is only `me`: no route names anyone else's.
    await request(app).get(`/api/v1/drug-lists/${doctor.userId}`).set(headersFor(colleague)).expect(400);
    await put(colleague, doctor.userId, id).expect(400);

    expect((await list(colleague, 'me')).body.data).toEqual([]);
    expect((await take(colleague, 'me', id).expect(200)).body.data).toEqual({ removed: false });

    const mine = await list(doctor, 'me');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].usual).toEqual({ durationDays: 9 });
  });

  test('a list belongs to one clinic: the same doctor elsewhere starts afresh', async () => {
    const { doctor } = await aClinic('+923015550015');
    const { doctor: other } = await aClinic('+923015550016');
    await catalog('Panadol');
    await put(doctor, 'clinic', await idOf('Panadol')).expect(200);

    expect((await list(other, 'clinic')).body.data).toEqual([]);
  });

  describe('own items', () => {
    test('POST for the clinic makes a clinic row on its list, verified, seen by the clinic alone', async () => {
      const { doctor } = await aClinic('+923015550020');
      const { doctor: stranger } = await aClinic('+923015550021');

      const created = await addOwn(doctor, {
        brand: 'Local Syrup',
        generic: 'Honey',
        strength: '5ml',
        form: 'syp',
        pack: '100ml',
        company: 'House',
        for: 'clinic',
      }).expect(201);

      expect(created.body.data.drug).toMatchObject({
        brand: 'Local Syrup',
        generic: 'Honey',
        form: 'syp',
        pack: '100ml',
        scope: 'clinic',
        source: 'clinic',
        status: 'active',
        drapRegNo: null,
        verified: true,
      });
      expect((await list(doctor, 'clinic')).body.data).toHaveLength(1);
      expect(await suggest(stranger, 'local')).toEqual([]);
      expect(await AuditLog.countDocuments({ action: 'drug.create' })).toBe(1);
    });

    test('POST for me makes a doctor row on their list, typed and unverified', async () => {
      const { doctor } = await aClinic('+923015550022');
      const colleague = await aSecondDoctor(doctor, '+923015550023');

      const created = await addOwn(doctor, { brand: 'My Own', for: 'me' }).expect(201);

      expect(created.body.data.drug).toMatchObject({ scope: 'doctor', source: 'typed', verified: false });
      expect((await list(doctor, 'me')).body.data).toHaveLength(1);
      expect(await suggest(colleague, 'my own')).toEqual([]);
    });

    test('an exact duplicate the caller can already see is reused, and put on the list', async () => {
      const { doctor } = await aClinic('+923015550024');
      await importDrugs(`${HEADER}\nR1,Panadol,,500 mg,Tablet,,`);
      const before = await Drug.countDocuments();

      const reused = await addOwn(doctor, { brand: ' PANADOL ', strength: '500mg', form: 'tab', for: 'me' }).expect(200);

      expect(reused.body.data.drug).toMatchObject({ id: await idOf('Panadol'), scope: 'national' });
      expect(await Drug.countDocuments()).toBe(before);
      expect((await list(doctor, 'me')).body.data).toHaveLength(1);

      // Twice is the same again.
      await addOwn(doctor, { brand: 'panadol', strength: '500 mg', form: 'tab', for: 'me' }).expect(200);
      expect((await list(doctor, 'me')).body.data).toHaveLength(1);

      await addOwn(doctor, { brand: 'Clinic Thing', for: 'clinic' }).expect(201);
      const clinicThing = await addOwn(doctor, { brand: 'clinic thing', for: 'me' }).expect(200);
      expect(clinicThing.body.data.drug.scope).toBe('clinic');
    });

    test("for the clinic, a doctor's own row is not a duplicate, because it cannot go there", async () => {
      const { doctor } = await aClinic('+923015550025');
      await addOwn(doctor, { brand: 'Shared Name', for: 'me' }).expect(201);

      const { body } = await addOwn(doctor, { brand: 'Shared Name', for: 'clinic' }).expect(201);

      expect(body.data.drug.scope).toBe('clinic');
    });

    test('a discontinued product is not a duplicate: the caller gets a row of their own', async () => {
      const { doctor } = await aClinic('+923015550026');
      await catalog('Gone', 'Keeper');
      await importDrugs(`${HEADER}\nR2,Keeper,,,Tablet,10x10,Acme`, { discontinueMissing: true });

      const { body } = await addOwn(doctor, { brand: 'Gone', for: 'clinic' }).expect(201);

      expect(body.data.drug).toMatchObject({ scope: 'clinic', status: 'active' });
    });

    test('a bad body is refused', async () => {
      const { doctor } = await aClinic('+923015550027');
      await addOwn(doctor, { brand: 'x' }).expect(400);
      await addOwn(doctor, { brand: '', for: 'me' }).expect(400);
      await addOwn(doctor, { brand: 'x', for: 'everyone' }).expect(400);
      await addOwn(doctor, { brand: 'x', form: 'potion', for: 'me' }).expect(400);
    });

    test('PATCH corrects a row and its search keys, changes only what is sent, and is audited', async () => {
      const { doctor } = await aClinic('+923015550028');
      const created = await addOwn(doctor, { brand: 'Panadl', generic: 'Paracetamol', pack: '10', for: 'clinic' }).expect(
        201,
      );
      const { id } = created.body.data.drug;

      const { body } = await request(app)
        .patch(`/api/v1/drugs/${id}`)
        .set(headersFor(doctor))
        .send({ brand: 'Panadol' })
        .expect(200);

      expect(body.data).toMatchObject({ brand: 'Panadol', generic: 'Paracetamol', pack: '10', scope: 'clinic' });
      expect(await suggest(doctor, 'panadl')).toEqual([]);
      expect(brands(await suggest(doctor, 'panadol'))).toEqual(['Panadol']);

      const entry = await AuditLog.findOne({ action: 'drug.update' }).lean();
      expect(entry).toMatchObject({ before: { brand: 'Panadl' }, after: { brand: 'Panadol' } });
    });

    test('who may correct what', async () => {
      const { doctor } = await aClinic('+923015550029');
      const colleague = await aSecondDoctor(doctor, '+923015550030');
      const manager = await aManager(doctor, '+923015550031');
      const { doctor: stranger } = await aClinic('+923015550032');
      await catalog('Panadol');

      const patch = (actor: SignedIn, id: string) =>
        request(app).patch(`/api/v1/drugs/${id}`).set(headersFor(actor)).send({ pack: '20' });

      // National rows can't be edited, by anyone.
      const national = await patch(doctor, await idOf('Panadol')).expect(403);
      expect(national.body.error.code).toBe('FORBIDDEN');
      await patch(manager, await idOf('Panadol')).expect(403);

      const clinicRow = (await addOwn(doctor, { brand: 'Local', for: 'clinic' }).expect(201)).body.data.drug.id;
      await patch(doctor, clinicRow).expect(200);
      await patch(colleague, clinicRow).expect(200);
      await patch(manager, clinicRow).expect(200);
      await patch(stranger, clinicRow).expect(404);

      const doctorRow = (await addOwn(doctor, { brand: 'Mine', for: 'me' }).expect(201)).body.data.drug.id;
      await patch(doctor, doctorRow).expect(200);
      await patch(colleague, doctorRow).expect(404);
      await patch(manager, doctorRow).expect(404);
    });

    test('correcting a row into one that already exists is a conflict, and sending nothing new writes nothing', async () => {
      const { doctor } = await aClinic('+923015550033');
      await addOwn(doctor, { brand: 'First', for: 'clinic' }).expect(201);
      const second = (await addOwn(doctor, { brand: 'Second', for: 'clinic' }).expect(201)).body.data.drug.id;

      const conflict = await request(app)
        .patch(`/api/v1/drugs/${second}`)
        .set(headersFor(doctor))
        .send({ brand: 'FIRST' })
        .expect(409);
      expect(conflict.body.error.code).toBe('CONFLICT');

      await request(app).patch(`/api/v1/drugs/${second}`).set(headersFor(doctor)).send({ brand: 'Second' }).expect(200);
      expect(await AuditLog.countDocuments({ action: 'drug.update' })).toBe(0);
      await request(app).patch(`/api/v1/drugs/${second}`).set(headersFor(doctor)).send({}).expect(400);
    });
  });
});

describe('Typed and dictated medicines', () => {
  test('a save creates nothing and counts nothing', async () => {
    const { doctor, patientId } = await aClinic('+923016660001');

    const saved = await drafted(doctor, patientId, [lineFor('Brand New', null, '5mg')]);

    expect(saved.sections.medicines[0].drugId).toBeNull();
    expect(await Drug.countDocuments()).toBe(0);
    expect(await DrugList.countDocuments()).toBe(0);
    expect(await DrugUsage.countDocuments()).toBe(0);
  });

  test('a save links a line to a drug the doctor can see, ignoring case and spacing, and still counts nothing', async () => {
    const { doctor, patientId } = await aClinic('+923016660002');
    await importDrugs(`${HEADER}\nR1,Panadol Extra,,500 mg,Tablet,,`);

    const saved = await drafted(doctor, patientId, [lineFor('panadol  EXTRA', null, '500mg', 'tab')]);

    expect(saved.sections.medicines[0].drugId).toBe(await idOf('Panadol Extra'));
    // The prescription keeps what was written.
    expect(saved.sections.medicines[0].name).toBe('panadol  EXTRA');
    expect(await DrugUsage.countDocuments()).toBe(0);
  });

  test('a save does not link to what the doctor cannot see', async () => {
    const { doctor, patientId } = await aClinic('+923016660003');
    const { doctor: stranger } = await aClinic('+923016660004');
    const colleague = await aSecondDoctor(doctor, '+923016660005');
    await addOwn(stranger, { brand: 'Their Item', for: 'clinic' }).expect(201);
    await addOwn(colleague, { brand: 'Colleague Item', for: 'me' }).expect(201);

    const saved = await drafted(doctor, patientId, [lineFor('Their Item'), lineFor('Colleague Item')]);

    expect(saved.sections.medicines.map((line: { drugId: unknown }) => line.drugId)).toEqual([null, null]);
  });

  test("approval makes one doctor row on the doctor's list, and counts the usage", async () => {
    const { doctor, patientId } = await aClinic('+923016660006');

    const approved = await prescribe(doctor, patientId, lineFor('Brand New', null, '5mg', 'cap'));

    const { drugId } = approved.sections.medicines[0];
    expect(drugId).toMatch(/^[0-9a-f]{24}$/);
    expect(await Drug.findById(drugId).lean()).toMatchObject({
      brand: 'Brand New',
      strength: '5mg',
      form: 'cap',
      scope: 'doctor',
      source: 'typed',
      status: 'active',
      drapRegNo: null,
    });

    const page = await list(doctor, 'me');
    expect(page.body.data.map((item: { drug: { id: string; verified: boolean } }) => item.drug)).toEqual([
      expect.objectContaining({ id: drugId, verified: false }),
    ]);

    const usage = await DrugUsage.find().lean();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ count: 1 });
    expect(String(usage[0].doctorId)).toBe(doctor.userId);
    expect(String(usage[0].practiceId)).toBe(doctor.practiceId);
    expect(usage[0].lastUsedAt).toEqual(expect.any(Date));
  });

  test('a second approval of the same name reuses that row and counts again', async () => {
    const { doctor, patientId } = await aClinic('+923016660007');

    const first = await prescribe(doctor, patientId, lineFor('Brand New', null, '5mg', 'cap'));
    const second = await prescribe(doctor, patientId, lineFor('BRAND  new', null, '5 mg', 'cap'));

    expect(second.sections.medicines[0].drugId).toBe(first.sections.medicines[0].drugId);
    expect(await Drug.countDocuments()).toBe(1);
    expect((await list(doctor, 'me')).body.data).toHaveLength(1);
    expect((await DrugUsage.findOne())?.count).toBe(2);
  });

  test('two lines on one prescription make one row and one use', async () => {
    const { doctor, patientId } = await aClinic('+923016660008');

    const approved = await prescribe(doctor, patientId, lineFor('Twice', null, '5mg'), lineFor('twice', null, '5mg'));

    const ids = approved.sections.medicines.map((line: { drugId: string }) => line.drugId);
    expect(ids[0]).toBe(ids[1]);
    expect(await Drug.countDocuments()).toBe(1);
    expect((await DrugUsage.findOne())?.count).toBe(1);
  });

  test('usage counts once per approval, never on a save, and for the one who signed', async () => {
    const { doctor, patientId } = await aClinic('+923016660009');
    const colleague = await aSecondDoctor(doctor, '+923016660010');
    await catalog('Panadol');
    const id = await idOf('Panadol');

    const saved = await drafted(doctor, patientId, [lineFor('Panadol', id)]);
    await request(app)
      .patch(`/api/v1/prescriptions/${saved.id}`)
      .set(headersFor(doctor, { location: true }))
      .send({ ops: [lineFor('Something Else')] })
      .expect(200);
    expect(await DrugUsage.countDocuments()).toBe(0);

    await approve(colleague, saved.id);

    const usage = await DrugUsage.find({ drugId: id }).lean();
    expect(usage).toHaveLength(1);
    expect(usage[0].count).toBe(1);
    expect(String(usage[0].doctorId)).toBe(colleague.userId);
  });

  test('a typed row the doctor took off goes back on their list when they prescribe it again', async () => {
    const { doctor, patientId } = await aClinic('+923016660011');
    const first = await prescribe(doctor, patientId, lineFor('Comes Back'));
    const { drugId } = first.sections.medicines[0];
    await take(doctor, 'me', drugId).expect(200);

    const second = await prescribe(doctor, patientId, lineFor('Comes Back'));

    expect(second.sections.medicines[0].drugId).toBe(drugId);
    expect((await list(doctor, 'me')).body.data).toHaveLength(1);
  });

  test('a line naming a catalog drug links to it at approval, and goes on no list', async () => {
    const { doctor, patientId } = await aClinic('+923016660012');
    await catalog('Panadol');

    const approved = await prescribe(doctor, patientId, lineFor('Panadol'));

    expect(approved.sections.medicines[0].drugId).toBe(await idOf('Panadol'));
    expect((await list(doctor, 'me')).body.data).toEqual([]);
    expect(await Drug.countDocuments({ scope: 'doctor' })).toBe(0);
  });

  test("a doctor's line links to the row on their own list, where one product has several", async () => {
    const { doctor, patientId } = await aClinic('+923016660013');
    await importDrugs(`${HEADER}\nR1,Panadol,,,Tablet,10,\nR2,Panadol,,,Tablet,20,`);
    const second = await Drug.findOne({ drapRegNo: 'R2' });
    await put(doctor, 'me', String(second!._id)).expect(200);

    const saved = await drafted(doctor, patientId, [lineFor('Panadol')]);

    expect(saved.sections.medicines[0].drugId).toBe(String(second!._id));
  });

  test("a drug id the doctor may not use is treated as typed: it cannot reach another clinic's row", async () => {
    const { doctor, patientId } = await aClinic('+923016660014');
    const { doctor: stranger } = await aClinic('+923016660015');
    const theirs = (await addOwn(stranger, { brand: 'Their Item', for: 'clinic' }).expect(201)).body.data.drug.id;

    const saved = await drafted(doctor, patientId, [lineFor('Their Item', theirs)]);
    expect(saved.sections.medicines[0].drugId).toBeNull();

    const approved = await approve(doctor, saved.id);
    expect(approved.sections.medicines[0].drugId).not.toBe(theirs);
    expect(await DrugUsage.countDocuments({ drugId: theirs })).toBe(0);
  });

  test('renaming a linked line unlinks it, so the use goes to what was prescribed', async () => {
    const { doctor, patientId } = await aClinic('+923016660016');
    await catalog('Panadol');
    const id = await idOf('Panadol');
    const saved = await drafted(doctor, patientId, [lineFor('Panadol', id)]);

    const renamed = await request(app)
      .patch(`/api/v1/prescriptions/${saved.id}`)
      .set(headersFor(doctor, { location: true }))
      .send({
        ops: [{ op: 'update', section: 'medicines', itemId: saved.sections.medicines[0].id, value: { name: 'Brufen' } }],
      })
      .expect(200);

    expect(renamed.body.data.sections.medicines[0].drugId).toBeNull();
    await approve(doctor, saved.id);
    expect(await DrugUsage.countDocuments({ drugId: id })).toBe(0);
  });

  test('approval never fails over any of this', async () => {
    const { doctor, patientId } = await aClinic('+923016660017');
    const saved = await drafted(doctor, patientId, [lineFor('Unlucky')]);

    const upsert = jest.spyOn(Drug, 'findOneAndUpdate').mockRejectedValue(new Error('the catalog is down') as never);
    const count = jest.spyOn(DrugUsage, 'bulkWrite').mockRejectedValue(new Error('so is usage') as never);
    const approved = await approve(doctor, saved.id);
    upsert.mockRestore();
    count.mockRestore();

    expect(approved.status).toBe('approved');
    expect(approved.sections.medicines[0]).toMatchObject({ name: 'Unlucky', drugId: null });
  });

  test('a row made at approval is audited', async () => {
    const { doctor, patientId } = await aClinic('+923016660018');

    await prescribe(doctor, patientId, lineFor('Audited One'));

    const actions = (await AuditLog.find({ entity: 'drug' }).sort({ _id: 1 }).lean()).map((entry) => entry.action);
    expect(actions).toEqual(['drug.create', 'drugList.add']);
  });
});

describe('The medicine manager', () => {
  test('a doctor can add one without locations, who reaches every location and only what the table says', async () => {
    const { doctor } = await aClinic('+923017770001');

    const added = await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923017770002', name: 'Hina', role: 'medicineManager' })
      .expect(201);
    expect(added.body.data).toMatchObject({ role: 'medicineManager', locationIds: [] });

    await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'Second branch' }).expect(201);

    const manager = await signIn('+923017770002');
    const me = await request(app)
      .get('/api/v1/me')
      .set({ Authorization: `Bearer ${manager.accessToken}` })
      .expect(200);
    const [membership] = me.body.data.memberships;
    expect(membership.role).toBe('medicineManager');
    expect(membership.locations).toHaveLength(2);
    expect(membership.can).toEqual(actionsFor('medicineManager'));
    expect([...membership.can].sort()).toEqual(
      ['drug.propose', 'drug.search', 'drugList.clinic.manage', 'drugList.read', 'settings.read'].sort(),
    );
  });

  test('an assistant still needs a location, and any locations sent for a manager are not kept', async () => {
    const { doctor } = await aClinic('+923017770003');

    const refused = await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923017770004', name: 'Sana', role: 'pa' })
      .expect(400);
    expect(refused.body.error.details).toEqual([{ field: 'body.locationIds', message: 'needs at least one location' }]);
    // Leaving out the role still means an assistant.
    await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923017770004', name: 'Sana' })
      .expect(400);

    const added = await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923017770005', role: 'medicineManager', locationIds: [doctor.locationId] })
      .expect(201);
    expect(added.body.data.locationIds).toEqual([]);
  });

  test('the role never changes once given', async () => {
    const { doctor } = await aClinic('+923017770006');
    const added = await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923017770007', role: 'medicineManager' })
      .expect(201);
    const pa = await request(app)
      .post('/api/v1/members')
      .set(headersFor(doctor))
      .send({ phone: '+923017770008', role: 'pa', locationIds: [doctor.locationId] })
      .expect(201);

    const change = (id: string, body: object) =>
      request(app).patch(`/api/v1/members/${id}`).set(headersFor(doctor)).send(body);

    await change(added.body.data.id, { role: 'pa' }).expect(400);
    await change(added.body.data.id, { role: 'doctor' }).expect(400);
    await change(pa.body.data.id, { role: 'medicineManager' }).expect(400);

    // Their name can change, and locations mean nothing for them.
    const renamed = await change(added.body.data.id, { name: 'Hina', locationIds: [doctor.locationId] }).expect(200);
    expect(renamed.body.data).toMatchObject({ role: 'medicineManager', name: 'Hina', locationIds: [] });
  });

  test('they manage the clinic list and its own items', async () => {
    const { doctor } = await aClinic('+923017770009');
    const manager = await aManager(doctor, '+923017770010');
    await catalog('Panadol');
    const id = await idOf('Panadol');

    await put(manager, 'clinic', id, { usual: { durationDays: 3 } }).expect(200);
    expect((await list(manager, 'clinic')).body.data).toHaveLength(1);
    expect((await list(doctor, 'clinic')).body.data).toHaveLength(1);
    await take(manager, 'clinic', id).expect(200);

    const created = await addOwn(manager, { brand: 'Local', for: 'clinic' }).expect(201);
    expect(created.body.data.drug.scope).toBe('clinic');

    expect(brands(await suggest(manager, 'pana'))).toEqual(['Panadol']);
  });

  test('they have no list of their own, and cannot make one', async () => {
    const { doctor } = await aClinic('+923017770011');
    const manager = await aManager(doctor, '+923017770012');
    await catalog('Panadol');

    expect((await list(manager, 'me')).body.data).toEqual([]);
    await put(manager, 'me', await idOf('Panadol')).expect(403);
    await take(manager, 'me', await idOf('Panadol')).expect(403);
    await addOwn(manager, { brand: 'Mine', for: 'me' }).expect(403);
  });

  test("they can set the clinic's medicines.source, and it applies to the clinic", async () => {
    const { doctor } = await aClinic('+923017770013');
    const manager = await aManager(doctor, '+923017770014');

    const { body } = await request(app)
      .patch('/api/v1/settings/organisation')
      .set(headersFor(manager))
      .send({ values: [{ key: 'medicines.source', value: 'myList' }] })
      .expect(200);
    expect(body.data['medicines.source']).toMatchObject({ value: 'myList', source: 'organisation' });

    const forDoctor = await request(app).get('/api/v1/settings').set(headersFor(doctor)).expect(200);
    expect(forDoctor.body.data['medicines.source']).toMatchObject({ value: 'myList', source: 'organisation' });

    expect(await AuditLog.countDocuments({ action: 'settings.organisation.update', role: 'medicineManager' })).toBe(1);
  });

  test('they get FORBIDDEN on any other clinic setting, and a doctor does not', async () => {
    const { doctor } = await aClinic('+923017770015');
    const manager = await aManager(doctor, '+923017770016');
    const entry = SETTINGS['medicines.source'] as { organisationAction?: string };
    const action = entry.organisationAction;
    delete entry.organisationAction;

    try {
      const body = { values: [{ key: 'medicines.source', value: 'myList' }] };
      const refused = await request(app)
        .patch('/api/v1/settings/organisation')
        .set(headersFor(manager))
        .send(body)
        .expect(403);
      expect(refused.body.error.code).toBe('FORBIDDEN');
      await request(app).patch('/api/v1/settings/organisation').set(headersFor(doctor)).send(body).expect(200);
    } finally {
      entry.organisationAction = action;
    }
  });

  test('they get FORBIDDEN on patients, visits and prescriptions', async () => {
    const { doctor, patientId } = await aClinic('+923017770017');
    const manager = await aManager(doctor, '+923017770018');
    const location = headersFor(manager, { location: true });

    const refusals: [string, string, object | undefined][] = [
      ['get', '/api/v1/patients', undefined],
      ['get', `/api/v1/patients/${patientId}`, undefined],
      ['post', '/api/v1/patients', { name: 'Walk-in', age: 22, sex: 'female' }],
      ['get', `/api/v1/patients/${patientId}/history`, undefined],
      ['get', '/api/v1/visits', undefined],
      ['post', '/api/v1/visits', { patientId }],
      ['get', '/api/v1/prescriptions', undefined],
      ['post', '/api/v1/prescriptions', { patientId }],
      ['get', '/api/v1/appointments?from=2026-10-01&to=2026-10-31', undefined],
      ['get', '/api/v1/notifications', undefined],
      ['get', '/api/v1/templates', undefined],
      ['get', '/api/v1/members', undefined],
      ['get', '/api/v1/practice', undefined],
    ];

    await refusals.reduce(async (previous, [method, path, body]) => {
      await previous;
      const call = request(app)[method as 'get'](path).set(location);
      const { status, body: answer } = await (body ? call.send(body) : call);
      expect([path, status, answer.error?.code]).toEqual([path, 403, 'FORBIDDEN']);
    }, Promise.resolve());
  });

  test('an assistant can manage neither list, and cannot get round it with a bad body', async () => {
    const { doctor } = await aClinic('+923017770019');
    const pa = await aPa(doctor, '+923017770020');
    await catalog('Panadol');
    const id = await idOf('Panadol');

    await put(pa, 'me', id).expect(403);
    await put(pa, 'clinic', id).expect(403);
    await take(pa, 'me', id).expect(403);
    await take(pa, 'clinic', id).expect(403);
    await addOwn(pa, { brand: 'x', for: 'clinic' }).expect(403);
    await addOwn(pa, { brand: 'x', for: 'me' }).expect(403);
    await addOwn(pa, { nonsense: true }).expect(403);
    await request(app).get('/api/v1/drug-lists/clinic').set(headersFor(pa)).expect(403);
    await request(app).get('/api/v1/drugs').query({ q: 'pan' }).set(headersFor(pa)).expect(403);
    await request(app).patch(`/api/v1/drugs/${id}`).set(headersFor(pa)).send({ pack: '1' }).expect(403);

    // The settings route turns them away before it reads the body, as it always did.
    await request(app).patch('/api/v1/settings/organisation').set(headersFor(pa)).send({ nonsense: true }).expect(403);
    await request(app)
      .patch('/api/v1/settings/organisation')
      .set(headersFor(pa))
      .send({ values: [{ key: 'medicines.source', value: 'all' }] })
      .expect(403);
  });
});

describe('Live updates', () => {
  let live: Live;
  const opened: LiveClient[] = [];

  beforeAll(async () => {
    live = await startLive();
  });

  afterEach(() => {
    opened.forEach((client) => client.ws.terminate());
    opened.length = 0;
  });

  afterAll(async () => {
    await live.close();
  });

  const socketFor = async (actor: SignedIn) => {
    const client = await signedIn(live.url, actor, actor.locationId);
    opened.push(client);
    return client;
  };

  const everyoneInAClinic = async (phone: number) => {
    const { doctor, patientId } = await aClinic(`+9230188800${phone}`);
    const colleague = await aSecondDoctor(doctor, `+9230188800${phone + 1}`);
    const pa = await aPa(doctor, `+9230188800${phone + 2}`);
    const manager = await aManager(doctor, `+9230188800${phone + 3}`);
    const { doctor: stranger } = await aClinic(`+9230188800${phone + 4}`);
    const sockets = {
      doctor: await socketFor(doctor),
      colleague: await socketFor(colleague),
      pa: await socketFor(pa),
      manager: await socketFor(manager),
      stranger: await socketFor(stranger),
    };
    return { doctor, colleague, pa, manager, patientId, sockets };
  };

  type Sockets = Awaited<ReturnType<typeof everyoneInAClinic>>['sockets'];

  /** Who has heard `medicines`, once the ones who should have and a moment for anyone else. */
  const heard = async (sockets: Sockets, expected: (keyof Sockets)[]) => {
    await Promise.all(
      expected.map((name) =>
        sockets[name].until((inbox) => inbox.some((m) => m.type === 'changed' && m.topic === 'medicines')),
      ),
    );
    await pause(150);
    return (Object.keys(sockets) as (keyof Sockets)[])
      .filter((name) => sockets[name].changes('medicines').length > 0)
      .sort();
  };

  const CLINIC: (keyof Sockets)[] = ['colleague', 'doctor', 'manager', 'pa'];

  test("a change to the clinic's list reaches every socket in the clinic, and no other", async () => {
    const { doctor, sockets } = await everyoneInAClinic(10);
    await catalog('Panadol');
    const id = await idOf('Panadol');

    await put(doctor, 'clinic', id).expect(200);

    expect(await heard(sockets, CLINIC)).toEqual(CLINIC);
    const [message] = sockets.pa.changes('medicines');
    // A topic and an id, never the data.
    expect(message).toEqual({ type: 'changed', topic: 'medicines', id });
  });

  test('so do updating a usual, removing, adding a clinic item and correcting one', async () => {
    const { manager, sockets } = await everyoneInAClinic(20);
    await catalog('Panadol');
    const id = await idOf('Panadol');

    await put(manager, 'clinic', id).expect(200);
    await put(manager, 'clinic', id, { usual: { durationDays: 2 } }).expect(200);
    await take(manager, 'clinic', id).expect(200);
    const created = await addOwn(manager, { brand: 'Local', for: 'clinic' }).expect(201);
    await request(app)
      .patch(`/api/v1/drugs/${created.body.data.drug.id}`)
      .set(headersFor(manager))
      .send({ pack: '10' })
      .expect(200);

    await sockets.pa.until((inbox) => inbox.filter((m) => m.type === 'changed' && m.topic === 'medicines').length >= 5);
    expect(sockets.pa.changes('medicines')).toHaveLength(5);
  });

  test("a change to a doctor's own list reaches that doctor alone", async () => {
    const { doctor, sockets } = await everyoneInAClinic(30);
    await catalog('Panadol');

    await put(doctor, 'me', await idOf('Panadol')).expect(200);

    expect(await heard(sockets, ['doctor'])).toEqual(['doctor']);
  });

  test('so does a typed row, whether added, corrected or made at approval', async () => {
    const { doctor, patientId, sockets } = await everyoneInAClinic(40);

    const created = await addOwn(doctor, { brand: 'Mine', for: 'me' }).expect(201);
    await request(app)
      .patch(`/api/v1/drugs/${created.body.data.drug.id}`)
      .set(headersFor(doctor))
      .send({ pack: '10' })
      .expect(200);
    await prescribe(doctor, patientId, lineFor('Made At Approval'));

    await sockets.doctor.until((inbox) => inbox.filter((m) => m.type === 'changed' && m.topic === 'medicines').length >= 3);
    expect(await heard(sockets, ['doctor'])).toEqual(['doctor']);
  });

  test('writing nothing says nothing', async () => {
    const { doctor, sockets } = await everyoneInAClinic(50);
    await catalog('Panadol');
    const id = await idOf('Panadol');
    await put(doctor, 'clinic', id).expect(200);
    await sockets.doctor.until((inbox) => inbox.some((m) => m.type === 'changed' && m.topic === 'medicines'));

    await put(doctor, 'clinic', id).expect(200);
    await take(doctor, 'me', id).expect(200);
    await pause(150);

    expect(sockets.doctor.changes('medicines')).toHaveLength(1);
  });

  test('a medicine manager hears nothing about patients, visits or prescriptions, which an assistant does', async () => {
    const { doctor, patientId, sockets } = await everyoneInAClinic(60);
    await request(app)
      .post('/api/v1/visits')
      .set(headersFor(doctor, { location: true }))
      .send({ patientId })
      .expect(201);
    await prescribe(doctor, patientId, lineFor('Anything'));
    await request(app).patch(`/api/v1/patients/${patientId}`).set(headersFor(doctor)).send({ name: 'Renamed' }).expect(200);

    await sockets.pa.until((inbox) => inbox.some((m) => m.type === 'changed' && m.topic === 'prescriptions'));
    await pause(150);

    expect(sockets.pa.changes('visits').length).toBeGreaterThan(0);
    (
      ['visits', 'prescriptions', 'patients', 'vitals', 'appointments', 'reports', 'notifications', 'voice'] as const
    ).forEach((topic) => {
      expect([topic, sockets.manager.changes(topic)]).toEqual([topic, []]);
    });
  });
});
