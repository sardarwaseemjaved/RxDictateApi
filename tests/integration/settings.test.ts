import request from 'supertest';
import { Types } from 'mongoose';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, aPlatformAdmin, headersFor, pause, type SignedIn } from '../fixtures/clinic.fixture';
import { connect, signedIn, startLive, type Live, type LiveClient } from '../fixtures/realtime.fixture';
import { AuditLog, Setting } from '../../src/models';
import { SETTING_KEYS, SETTINGS, type SettingLayer } from '../../src/shared/settings';

setupTestDB();
jest.setTimeout(30_000);

const KEY = 'medicines.source';

const settingsOf = async (actor: SignedIn) =>
  (await request(app).get('/api/v1/settings').set(headersFor(actor)).expect(200)).body.data;

/** What applies to this person for the one key in the registry today. */
const sourceOf = async (actor: SignedIn) => (await settingsOf(actor))[KEY];

/** Any body, to any of the three layers' routes. */
const patch = (layer: 'me' | 'organisation' | 'platform', actor: SignedIn, body: unknown) =>
  request(app)
    .patch(`/api/v1/settings/${layer}`)
    .set(headersFor(actor))
    .send(body as object);

/** One change to the one key in the registry today. Null takes the layer's value away. */
const change = (value: unknown, locked?: boolean) => ({
  values: [{ key: KEY, value, ...(locked === undefined ? {} : { locked }) }],
});

const setMine = (actor: SignedIn, value: unknown) => patch('me', actor, change(value));
const setClinic = (actor: SignedIn, value: unknown, locked?: boolean) => patch('organisation', actor, change(value, locked));
const setPlatform = (actor: SignedIn, value: unknown, locked?: boolean) => patch('platform', actor, change(value, locked));

describe('Settings', () => {
  describe('working out what applies', () => {
    test('the default comes back when nothing is set, for every key in the registry', async () => {
      const { doctor } = await aClinic('+923002220001');
      const view = await settingsOf(doctor);

      expect(Object.keys(view)).toEqual(SETTING_KEYS);
      expect(view).toEqual(
        Object.fromEntries(
          SETTING_KEYS.map((key) => [key, { value: SETTINGS[key].default, source: 'default', locked: false }]),
        ),
      );
    });

    test("a person's own value beats the clinic's, unless the clinic locked it", async () => {
      const { doctor } = await aClinic('+923002220002');
      const pa = await aPa(doctor, '+923002220003');
      const { doctor: elsewhere } = await aClinic('+923002220004', 'Dr Elsewhere');

      await setClinic(doctor, 'myList').expect(200);
      expect(await sourceOf(pa)).toEqual({ value: 'myList', source: 'organisation', locked: false });

      // The answer to a write is the writer's settings, as GET would give them.
      const mine = await setMine(pa, 'all').expect(200);
      expect(mine.body.data[KEY]).toEqual({ value: 'all', source: 'user', locked: false });
      expect(await sourceOf(pa)).toEqual({ value: 'all', source: 'user', locked: false });

      // Theirs alone: the doctor still has the clinic's, and another clinic the default.
      expect(await sourceOf(doctor)).toEqual({ value: 'myList', source: 'organisation', locked: false });
      expect(await sourceOf(elsewhere)).toEqual({ value: 'myListFirst', source: 'default', locked: false });

      // Locked, the clinic's value wins over the one the assistant kept...
      await setClinic(doctor, 'myList', true).expect(200);
      expect(await sourceOf(pa)).toEqual({ value: 'myList', source: 'organisation', locked: true });

      // ...and the assistant cannot choose again, though they may take theirs away.
      const refused = await setMine(pa, 'myListFirst').expect(400);
      expect(refused.body.error).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [{ field: 'body.values.0.key', message: 'is locked by your clinic' }],
      });
      await setMine(pa, null).expect(200);
      expect(await Setting.countDocuments({ layer: 'user' })).toBe(0);

      // Unlocked by leaving the value and dropping the lock.
      await setClinic(doctor, 'myList', false).expect(200);
      await setMine(pa, 'all').expect(200);
      expect(await sourceOf(pa)).toEqual({ value: 'all', source: 'user', locked: false });
    });

    test('a platform lock beats both the clinic and the person', async () => {
      const { doctor } = await aClinic('+923002220005');
      const { doctor: elsewhere } = await aClinic('+923002220006', 'Dr Elsewhere');
      const admin = await aPlatformAdmin('+923002220007');

      await setMine(doctor, 'myListFirst').expect(200);
      await setClinic(doctor, 'myList', true).expect(200);

      // Unlocked, the platform's value is only the starting point.
      await setPlatform(admin, 'all').expect(200);
      expect(await sourceOf(doctor)).toEqual({ value: 'myList', source: 'organisation', locked: true });
      expect(await sourceOf(elsewhere)).toEqual({ value: 'all', source: 'platform', locked: false });

      // Locked, it is the answer everywhere.
      await setPlatform(admin, 'all', true).expect(200);
      expect(await sourceOf(doctor)).toEqual({ value: 'all', source: 'platform', locked: true });
      expect(await sourceOf(elsewhere)).toEqual({ value: 'all', source: 'platform', locked: true });
      expect(await sourceOf(admin)).toEqual({ value: 'all', source: 'platform', locked: true });

      const byClinic = await setClinic(doctor, 'myList').expect(400);
      expect(byClinic.body.error.details).toEqual([{ field: 'body.values.0.key', message: 'is locked by RxDictate' }]);
      const byPerson = await setMine(elsewhere, 'myList').expect(400);
      expect(byPerson.body.error.details).toEqual([{ field: 'body.values.0.key', message: 'is locked by RxDictate' }]);

      // Taken away, the clinic's lock is what applies again.
      await setPlatform(admin, null).expect(200);
      expect(await sourceOf(doctor)).toEqual({ value: 'myList', source: 'organisation', locked: true });
      expect(await sourceOf(elsewhere)).toEqual({ value: 'myListFirst', source: 'default', locked: false });
    });

    test('a stored value the registry no longer accepts counts as unset', async () => {
      const { doctor } = await aClinic('+923002220008');
      await setClinic(doctor, 'myList').expect(200);
      await Setting.updateOne({ layer: 'organisation' }, { $set: { value: 'retiredMode' } });

      expect(await sourceOf(doctor)).toEqual({ value: 'myListFirst', source: 'default', locked: false });
    });
  });

  describe('what each layer may set', () => {
    /** Change one registry entry for the length of a test, the way a future entry might differ. */
    const withEntry = async (override: { setBy?: SettingLayer[]; lockable?: boolean }, run: () => Promise<void>) => {
      const entry = SETTINGS[KEY];
      const { setBy, lockable } = entry;
      Object.assign(entry, override);
      try {
        await run();
      } finally {
        Object.assign(entry, { setBy, lockable });
      }
    };

    test('a key a layer may not set, a key not in the registry, and a bad value each get VALIDATION_ERROR', async () => {
      const { doctor } = await aClinic('+923002220010');
      const admin = await aPlatformAdmin('+923002220011');

      const refusals: [string, () => request.Test, string][] = [
        [
          'not a setting',
          () => patch('me', doctor, { values: [{ key: 'voice.enabled', value: false }] }),
          'body.values.0.key: is not a setting',
        ],
        ['not one of its values', () => setMine(doctor, 'everything'), 'body.values.0.value: Invalid option'],
        ['a lock from a person', () => patch('me', doctor, change('all', true)), 'Unrecognized key: "locked"'],
        ['a lock with no value', () => setClinic(doctor, null, true), 'body.values.0.locked: needs a value to lock'],
        [
          'the same key twice',
          () => patch('organisation', doctor, { values: [...change('all').values, ...change('myList').values] }),
          'body.values.1.key: is named more than once',
        ],
        ['an object keyed by setting', () => patch('organisation', doctor, { [KEY]: { value: 'all' } }), 'body.values'],
        ['nothing at all', () => patch('me', doctor, { values: [] }), 'nothing to change'],
      ];
      for (let i = 0; i < refusals.length; i += 1) {
        const [why, send, message] = refusals[i];
        // eslint-disable-next-line no-await-in-loop
        const response = await send();
        expect({ why, status: response.status, code: response.body.error?.code }).toEqual({
          why,
          status: 400,
          code: 'VALIDATION_ERROR',
        });
        expect(response.body.error.message).toContain(message);
      }

      // The entry as the registry was first drafted: the platform may not set it.
      await withEntry({ setBy: ['organisation', 'user'] }, async () => {
        const response = await setPlatform(admin, 'all').expect(400);
        expect(response.body.error.details).toEqual([{ field: 'body.values.0.key', message: 'cannot be set for everyone' }]);
      });
      await withEntry({ setBy: ['organisation'] }, async () => {
        const response = await setMine(doctor, 'all').expect(400);
        expect(response.body.error.details).toEqual([
          { field: 'body.values.0.key', message: 'cannot be set by a person for themselves' },
        ]);
      });
      await withEntry({ lockable: false }, async () => {
        const response = await setClinic(doctor, 'all', true).expect(400);
        expect(response.body.error.details).toEqual([{ field: 'body.values.0.locked', message: 'cannot be locked' }]);
      });

      expect(await Setting.countDocuments()).toBe(0);
    });

    test('an assistant cannot use PATCH /settings/organisation, and only a platform admin can use /settings/platform', async () => {
      const { doctor } = await aClinic('+923002220012');
      const pa = await aPa(doctor, '+923002220013');
      const admin = await aPlatformAdmin('+923002220014');

      const byPa = await setClinic(pa, 'all').expect(403);
      expect(byPa.body.error.code).toBe('FORBIDDEN');
      const byDoctor = await setPlatform(doctor, 'all').expect(403);
      expect(byDoctor.body.error.code).toBe('FORBIDDEN');
      // The platform has no clinic layer of its own to set.
      const byAdmin = await setClinic(admin, 'all').expect(403);
      expect(byAdmin.body.error.code).toBe('FORBIDDEN');

      expect(await Setting.countDocuments()).toBe(0);
    });

    test('each change is audited at its layer, and a write that changes nothing records nothing', async () => {
      const { doctor } = await aClinic('+923002220015');
      const admin = await aPlatformAdmin('+923002220016');

      await setClinic(doctor, 'myList', true).expect(200);
      await setClinic(doctor, 'myList').expect(200);
      await setMine(doctor, null).expect(200);
      await setPlatform(admin, 'all').expect(200);

      const entries = await AuditLog.find({ entity: 'setting' }).sort({ _id: 1 });
      expect(entries.map((entry) => [entry.action, String(entry.practiceId), entry.before, entry.after])).toEqual([
        ['settings.organisation.update', doctor.practiceId, [], [{ key: KEY, value: 'myList', locked: true }]],
        ['settings.platform.update', admin.practiceId, [], [{ key: KEY, value: 'all', locked: false }]],
      ]);
    });
  });

  describe('live updates', () => {
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

    /** Long enough for anything already sent to arrive over localhost. */
    const settle = () => pause(200);

    test("a person's change reaches them, a clinic's the whole clinic, and the platform's everyone", async () => {
      const { doctor } = await aClinic('+923002220020');
      const pa = await aPa(doctor, '+923002220021');
      const { doctor: elsewhere } = await aClinic('+923002220022', 'Dr Elsewhere');
      const admin = await aPlatformAdmin('+923002220023');

      const sockets = {
        doctor: await socketFor(doctor),
        pa: await socketFor(pa),
        elsewhere: await socketFor(elsewhere),
      };
      const heard = () => ({
        doctor: sockets.doctor.changes('settings').length,
        pa: sockets.pa.changes('settings').length,
        elsewhere: sockets.elsewhere.changes('settings').length,
      });

      await setMine(pa, 'all').expect(200);
      await sockets.pa.until(() => heard().pa === 1);
      await settle();
      expect(heard()).toEqual({ doctor: 0, pa: 1, elsewhere: 0 });

      await setClinic(doctor, 'myList').expect(200);
      await sockets.doctor.until(() => heard().doctor === 1);
      await sockets.pa.until(() => heard().pa === 2);
      await settle();
      expect(heard()).toEqual({ doctor: 1, pa: 2, elsewhere: 0 });

      await setPlatform(admin, 'all', true).expect(200);
      await sockets.elsewhere.until(() => heard().elsewhere === 1);
      await settle();
      expect(heard()).toEqual({ doctor: 2, pa: 3, elsewhere: 1 });

      // A write that changes nothing says nothing.
      await setPlatform(admin, 'all', true).expect(200);
      await settle();
      expect(heard()).toEqual({ doctor: 2, pa: 3, elsewhere: 1 });

      // Only that the settings changed, never to what.
      [sockets.doctor, sockets.pa, sockets.elsewhere].forEach((client) => {
        client.changes('settings').forEach((message) => expect(message).toEqual({ type: 'changed', topic: 'settings' }));
      });
    });

    test('a platform member cannot open the clinic socket: FORBIDDEN, as over HTTP', async () => {
      const admin = await aPlatformAdmin('+923002220024');
      const client = await connect(live.url);
      opened.push(client);

      client.auth(admin, new Types.ObjectId().toHexString());
      const error = await client.next((message) => message.type === 'error');
      expect(error).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
      expect(await client.closed).toEqual({ code: 1008, reason: 'FORBIDDEN' });
    });
  });
});
