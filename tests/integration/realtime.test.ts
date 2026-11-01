import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app';
import config from '../../src/config/config';
import {
  realtimeServerMessageSchema,
  type RealtimeServerMessage,
  type RealtimeTopic,
} from '../../src/shared/realtime.schema';
import { karachiDayRange, todayInKarachi } from '../../src/utils/time';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, aPa, dictate, headersFor, pause, signIn, type SignedIn } from '../fixtures/clinic.fixture';
import { connect, signedIn, startLive, type Live, type LiveClient } from '../fixtures/realtime.fixture';

setupTestDB();
jest.setTimeout(30_000);

let live: Live;
const opened: LiveClient[] = [];

beforeAll(async () => {
  live = await startLive();
});

afterAll(async () => {
  await live.close();
});

/** The keys each kind of message may carry, and nothing else: no names, phones or anything medical. */
const BARE: Record<RealtimeServerMessage['type'], string[]> = {
  ready: ['type'],
  heartbeat: ['type'],
  changed: ['type', 'topic', 'id'],
  error: ['type', 'code', 'message'],
};

const expectBare = (message: RealtimeServerMessage): void => {
  expect(realtimeServerMessageSchema.safeParse(message).success).toBe(true);
  expect(Object.keys(message).filter((key) => !BARE[message.type].includes(key))).toEqual([]);
};

// Every message any socket heard in any test is checked against the contract.
afterEach(() => {
  opened.forEach((client) => {
    client.inbox.forEach(expectBare);
    client.ws.terminate();
  });
  opened.length = 0;
});

const track = (client: LiveClient): LiveClient => {
  opened.push(client);
  return client;
};

/** A socket signed in as this member at this location. */
const socketFor = async (actor: SignedIn, location: string): Promise<LiveClient> =>
  track(await signedIn(live.url, actor, location));

const unsignedSocket = async (): Promise<LiveClient> => track(await connect(live.url));

const at = (actor: SignedIn, location: string) => headersFor(actor, { location });

/** Long enough for anything already sent to arrive over localhost; anything later was not coming. */
const settle = () => pause(200);

const changed = (topic: RealtimeTopic) => (message: RealtimeServerMessage) =>
  message.type === 'changed' && message.topic === topic;

const isError = (message: RealtimeServerMessage) => message.type === 'error';

/**
 * One clinic with locations A (the default) and B, an assistant at each, and
 * the fixture's patient, who was registered at A.
 */
const aTwoLocationClinic = async (prefix: string) => {
  const { doctor, patientId } = await aClinic(`${prefix}01`, 'Dr Live');
  const branch = await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'B' }).expect(201);
  const a = doctor.locationId;
  const b = branch.body.data.id as string;
  const atA = await aPa(doctor, `${prefix}02`, [a]);
  const atB = await aPa(doctor, `${prefix}03`, [b]);
  return { doctor, a, b, atA, atB, patientId };
};

const aPatient = async (actor: SignedIn, location: string, name = 'Rubina Live') =>
  (await request(app).post('/api/v1/patients').set(at(actor, location)).send({ name, age: 30, sex: 'female' }).expect(201))
    .body.data.id as string;

const aVisit = async (actor: SignedIn, location: string, patientId: string) =>
  (await request(app).post('/api/v1/visits').set(at(actor, location)).send({ patientId }).expect(201)).body.data
    .id as string;

const aReport = async (doctor: SignedIn, patientId: string) =>
  (
    await request(app)
      .post(`/api/v1/patients/${patientId}/reports`)
      .set(headersFor(doctor))
      .send({ type: 'lab', testName: 'CBC', testDate: '2026-10-01', pageKeys: [`${doctor.practiceId}/reports/pages/a.jpg`] })
      .expect(201)
  ).body.data.id as string;

const memberIdOf = async (doctor: SignedIn, actor: SignedIn) => {
  const members = await request(app).get('/api/v1/members').set(headersFor(doctor)).expect(200);
  return (members.body.data as { id: string; userId: string }[]).find((member) => member.userId === actor.userId)!.id;
};

const uploadSegment = (doctor: SignedIn, prescriptionId: string, seq: number, audioBase64: string) =>
  request(app)
    .post(`/api/v1/prescriptions/${prescriptionId}/voice/segments`)
    .set(headersFor(doctor, { location: true }))
    .send({ seq, durationMs: 12_000, contentType: 'audio/m4a', audioBase64 })
    .expect(201);

const APPLIES = dictate([{ op: 'add', section: 'advice', value: { text: 'Rest' } }]);
const FAILS = dictate([{ op: 'update', section: 'diagnosis', itemId: 'made-up-id', value: { text: 'Dengue' } }]);

/** An access token for the same sign-in that runs out in `seconds`. */
const tokenFor = (actor: SignedIn, seconds: number) => {
  const { sid } = jwt.decode(actor.accessToken) as { sid: string };
  return jwt.sign({ sub: actor.userId, sid, type: 'access' }, config.jwt.secret, { expiresIn: seconds });
};

/**
 * Do a write and check it sent this socket exactly one message on a topic,
 * naming the id the write returns (or none, for notifications).
 */
const onlyMessage = async (
  client: LiveClient,
  topic: RealtimeTopic,
  write: () => Promise<string | undefined>,
): Promise<string | undefined> => {
  const before = client.changes(topic).length;
  const id = await write();
  await client.until(() => client.changes(topic).length > before);
  await settle();
  expect(client.changes(topic).slice(before)).toEqual([{ type: 'changed', topic, ...(id ? { id } : {}) }]);
  return id;
};

describe('Realtime', () => {
  describe('signing in', () => {
    test('a good token gives ready', async () => {
      const { doctor, a, atA } = await aTwoLocationClinic('+92300701');

      const doc = await unsignedSocket();
      doc.auth(doctor, a);
      expect(await doc.next(() => true)).toEqual({ type: 'ready' });

      const assistant = await unsignedSocket();
      assistant.auth(atA, a);
      expect(await assistant.next(() => true)).toEqual({ type: 'ready' });
    });

    test('anything but a valid auth is ignored, and nothing is sent before ready', async () => {
      const { doctor, a, patientId } = await aTwoLocationClinic('+92300702');
      const client = await unsignedSocket();

      client.send('not json at all');
      client.send({ type: 'subscribe', topic: 'visits' });
      client.send({ type: 'auth', token: doctor.accessToken });
      client.send({ type: 'auth', token: doctor.accessToken, practiceId: 'nope', locationId: a });
      // A write at this location reaches nobody who has not signed in.
      await aVisit(doctor, a, patientId);
      await settle();
      expect(client.inbox).toEqual([]);
      expect(client.isOpen).toBe(true);

      client.auth(doctor, a);
      await client.next((message) => message.type === 'ready');
      expect(client.inbox).toEqual([{ type: 'ready' }]);
    });

    test('a bad token, an expired token, a revoked session, a non-member and a location not allowed each give their code and close', async () => {
      const { doctor, a, b, atA } = await aTwoLocationClinic('+92300703');
      const elsewhere = await aClinic('+9230070399', 'Dr Elsewhere');

      const laptop = await signIn(doctor.phone, undefined, 'second-laptop');
      await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${laptop.accessToken}`)
        .send({ refreshToken: laptop.refreshToken })
        .expect(200);

      const attempts: [(client: LiveClient) => void, string][] = [
        [(client) => client.auth(doctor, a, 'not-a-token'), 'TOKEN_INVALID'],
        [(client) => client.auth(doctor, a, tokenFor(doctor, -60)), 'TOKEN_EXPIRED'],
        [(client) => client.auth(laptop, a), 'SESSION_REVOKED'],
        [(client) => client.auth({ ...elsewhere.doctor, practiceId: doctor.practiceId }, a), 'NOT_MEMBER'],
        [(client) => client.auth(atA, b), 'LOCATION_NOT_ALLOWED'],
      ];

      const outcomes = await Promise.all(
        attempts.map(async ([attempt]) => {
          const client = await unsignedSocket();
          attempt(client);
          const error = await client.next(isError);
          return { error, closed: await client.closed, heard: client.inbox.length };
        }),
      );

      outcomes.forEach(({ error, closed, heard }, index) => {
        const code = attempts[index][1];
        expect(error).toMatchObject({ type: 'error', code });
        expect(closed).toEqual({ code: 1008, reason: code });
        expect(heard).toBe(1);
      });
    });

    test('a removed member and an archived location get the codes their HTTP requests would', async () => {
      const { doctor, a, b, atA } = await aTwoLocationClinic('+92300704');
      await request(app)
        .delete(`/api/v1/members/${await memberIdOf(doctor, atA)}`)
        .set(headersFor(doctor))
        .expect(200);
      await request(app).post(`/api/v1/locations/${b}/archive`).set(headersFor(doctor)).expect(200);

      const removed = await unsignedSocket();
      removed.auth(atA, a);
      expect(await removed.next(isError)).toMatchObject({ code: 'MEMBERSHIP_REMOVED' });

      const archived = await unsignedSocket();
      archived.auth(doctor, b);
      expect(await archived.next(isError)).toMatchObject({ code: 'LOCATION_ARCHIVED' });
    });

    test('a browser on an origin CORS does not allow is turned away; the app, which sends none, is not', async () => {
      await expect(connect(live.url, { origin: 'https://not-ours.example' })).rejects.toThrow('403');

      const browser = track(await connect(live.url, { origin: config.cors.origins[0] }));
      expect(browser.isOpen).toBe(true);
      const phoneApp = await unsignedSocket();
      expect(phoneApp.isOpen).toBe(true);
    });

    test('only the realtime path upgrades', async () => {
      await expect(connect(live.url.replace('/realtime', '/visits'))).rejects.toThrow('404');
    });

    test('a fresh auth keeps the socket open past the old expiry', async () => {
      const { doctor } = await aClinic('+9230070111');
      const client = await unsignedSocket();

      client.auth(doctor, doctor.locationId, tokenFor(doctor, 2));
      await client.next((message) => message.type === 'ready');
      client.auth(doctor, doctor.locationId);

      await pause(2500);
      expect(client.isOpen).toBe(true);
      expect(client.inbox).toEqual([{ type: 'ready' }]);
    });

    test('with no fresh auth the socket is closed with TOKEN_EXPIRED when the token runs out', async () => {
      const { doctor } = await aClinic('+9230070112');
      const client = await unsignedSocket();

      client.auth(doctor, doctor.locationId, tokenFor(doctor, 2));
      await client.next((message) => message.type === 'ready');

      expect(await client.next(isError, 4000)).toMatchObject({ code: 'TOKEN_EXPIRED' });
      expect(await client.closed).toEqual({ code: 1008, reason: 'TOKEN_EXPIRED' });
    });

    test('a later auth for another location needs a new connection', async () => {
      const { doctor, a, b } = await aTwoLocationClinic('+92300705');
      const client = await socketFor(doctor, a);

      client.auth(doctor, b);
      expect(await client.next(isError)).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect((await client.closed).code).toBe(1008);
    });
  });

  describe('who hears what', () => {
    test("an assistant at A hears A's visits and not B's", async () => {
      const { doctor, a, b, atA, atB, patientId } = await aTwoLocationClinic('+92300711');
      const [hereA, hereB] = await Promise.all([socketFor(atA, a), socketFor(atB, b)]);

      const visitAtA = await aVisit(doctor, a, patientId);
      await hereA.next(changed('visits'));
      await settle();
      expect(hereA.changes('visits')).toEqual([{ type: 'changed', topic: 'visits', id: visitAtA }]);
      expect(hereB.changes('visits')).toEqual([]);

      const visitAtB = await aVisit(doctor, b, patientId);
      await hereB.next(changed('visits'));
      await settle();
      expect(hereB.changes('visits')).toEqual([{ type: 'changed', topic: 'visits', id: visitAtB }]);
      expect(hereA.changes('visits')).toHaveLength(1);
    });

    test('patients and reports reach the doctors and the assistants of a linked location only', async () => {
      const { doctor, a, b, atA, atB } = await aTwoLocationClinic('+92300712');
      const [doc, hereA, hereB] = await Promise.all([socketFor(doctor, a), socketFor(atA, a), socketFor(atB, b)]);
      const told = [doc, hereA];

      const patientId = await aPatient(atA, a);
      await request(app).patch(`/api/v1/patients/${patientId}`).set(at(atA, a)).send({ name: 'Rubina L' }).expect(200);
      const reportId = await aReport(doctor, patientId);
      await request(app).post(`/api/v1/reports/${reportId}/review`).set(headersFor(doctor)).expect(200);

      await Promise.all(
        told.map((client) =>
          client.until(() => client.changes('patients').length === 2 && client.changes('reports').length === 2),
        ),
      );
      await settle();

      told.forEach((client) => {
        expect(client.changes('patients')).toEqual(Array(2).fill({ type: 'changed', topic: 'patients', id: patientId }));
        expect(client.changes('reports')).toEqual(Array(2).fill({ type: 'changed', topic: 'reports', id: reportId }));
      });
      expect(hereB.changes('patients')).toEqual([]);
      expect(hereB.changes('reports')).toEqual([]);
    });

    test('notifications reach only the person they are for, on every device', async () => {
      const { doctor, a, b, atA, atB, patientId } = await aTwoLocationClinic('+92300713');
      const visitId = await aVisit(atA, a, patientId);
      const phone = await signIn(doctor.phone, undefined, 'second-phone');
      const [doc, docPhone, hereA, hereB] = await Promise.all([
        socketFor(doctor, a),
        socketFor(phone, a),
        socketFor(atA, a),
        socketFor(atB, b),
      ]);

      // Vitals are the doctor's to hear about, so the notification is theirs alone.
      await request(app).put(`/api/v1/visits/${visitId}/vitals`).set(at(atA, a)).send({ pulse: 76 }).expect(200);
      await Promise.all([doc, docPhone].map((client) => client.next(changed('notifications'))));

      // Read on one device; the badge moves on the other.
      const inbox = await request(app).get('/api/v1/notifications').set(headersFor(doctor)).expect(200);
      await request(app)
        .post('/api/v1/notifications/read')
        .set(headersFor(doctor))
        .send({ ids: inbox.body.data.map((notification: { id: string }) => notification.id) })
        .expect(200);
      await docPhone.until(() => docPhone.changes('notifications').length === 2);
      await settle();

      expect(docPhone.changes('notifications')).toEqual(Array(2).fill({ type: 'changed', topic: 'notifications' }));
      expect(doc.changes('notifications')).toHaveLength(2);
      expect(hereA.changes('notifications')).toEqual([]);
      expect(hereB.changes('notifications')).toEqual([]);
    });

    test('voice reaches only the doctor whose prescription it is', async () => {
      const { doctor, a, atA, patientId } = await aTwoLocationClinic('+92300714');
      await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+9230071405', name: 'Dr Second', role: 'doctor', locationIds: [a] })
        .expect(201);
      const colleague = await signIn('+9230071405');
      const [doc, other, hereA] = await Promise.all([socketFor(doctor, a), socketFor(colleague, a), socketFor(atA, a)]);
      const draft = await aDraft(doctor, patientId, 'voice');

      await uploadSegment(doctor, draft.id, 1, APPLIES);
      await doc.next(changed('voice'));
      await uploadSegment(doctor, draft.id, 2, FAILS);
      await doc.until(() => doc.changes('voice').length === 2);
      await settle();

      expect(doc.changes('voice')).toEqual(Array(2).fill({ type: 'changed', topic: 'voice', id: draft.id }));
      expect(other.changes('voice')).toEqual([]);
      expect(hereA.changes('voice')).toEqual([]);
    });
  });

  describe('every row of the table: one write, one message', () => {
    test('visits: added to the day, moved in the order, status changed', async () => {
      const { doctor, a, patientId } = await aTwoLocationClinic('+92300721');
      const second = await aPatient(doctor, a, 'Second Patient');
      const doc = await socketFor(doctor, a);

      const first = await onlyMessage(doc, 'visits', () => aVisit(doctor, a, patientId));
      const next = await onlyMessage(doc, 'visits', () => aVisit(doctor, a, second));
      await onlyMessage(doc, 'visits', async () => {
        await request(app).post(`/api/v1/visits/${next}/move`).set(at(doctor, a)).send({ before: first }).expect(200);
        return next;
      });
      await onlyMessage(doc, 'visits', async () => {
        await request(app).patch(`/api/v1/visits/${first}`).set(at(doctor, a)).send({ status: 'with_doctor' }).expect(200);
        return first;
      });
    });

    test('vitals: recorded', async () => {
      const { doctor, a, atA, patientId } = await aTwoLocationClinic('+92300722');
      const visitId = await aVisit(atA, a, patientId);
      const doc = await socketFor(doctor, a);

      await onlyMessage(doc, 'vitals', async () => {
        await request(app).put(`/api/v1/visits/${visitId}/vitals`).set(at(atA, a)).send({ pulse: 76 }).expect(200);
        return visitId;
      });
    });

    test('prescriptions: approved and revised', async () => {
      const { doctor, a, patientId } = await aTwoLocationClinic('+92300723');
      const draft = await aDraft(doctor, patientId);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(at(doctor, a))
        .send({ ops: [{ op: 'add', section: 'complaints', value: { text: 'Fever' } }] })
        .expect(200);
      const doc = await socketFor(doctor, a);

      await onlyMessage(doc, 'prescriptions', async () => {
        await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(at(doctor, a)).expect(200);
        return draft.id as string;
      });
      await onlyMessage(
        doc,
        'prescriptions',
        async () =>
          (
            await request(app)
              .post(`/api/v1/prescriptions/${draft.id}/revise`)
              .set(at(doctor, a))
              .send({ reason: 'wrong dose' })
              .expect(201)
          ).body.data.id as string,
      );
    });

    test('appointments: booked, cancelled, and kept when the patient arrives', async () => {
      const { doctor, a, atA, patientId } = await aTwoLocationClinic('+92300724');
      const doc = await socketFor(doctor, a);
      const book = async (when: Date) =>
        (
          await request(app)
            .post('/api/v1/appointments')
            .set(at(atA, a))
            .send({ patientId, at: when.toISOString(), kind: 'follow_up' })
            .expect(201)
        ).body.data.id as string;

      const { start } = karachiDayRange(todayInKarachi());
      const later = await onlyMessage(doc, 'appointments', () => book(new Date(start.getTime() + 3 * 24 * 3600_000)));
      await onlyMessage(doc, 'appointments', async () => {
        await request(app).post(`/api/v1/appointments/${later}/cancel`).set(at(atA, a)).expect(200);
        return later;
      });

      const today = await onlyMessage(doc, 'appointments', () => book(new Date(start.getTime() + 12 * 3600_000)));
      await onlyMessage(doc, 'appointments', async () => {
        await aVisit(atA, a, patientId);
        return today;
      });
    });

    test('patients: added and edited', async () => {
      const { doctor, a } = await aTwoLocationClinic('+92300725');
      const doc = await socketFor(doctor, a);

      const patientId = await onlyMessage(doc, 'patients', () => aPatient(doctor, a));
      await onlyMessage(doc, 'patients', async () => {
        await request(app).patch(`/api/v1/patients/${patientId}`).set(headersFor(doctor)).send({ age: 31 }).expect(200);
        return patientId;
      });
    });

    test('reports: uploaded and reviewed', async () => {
      const { doctor, a, patientId } = await aTwoLocationClinic('+92300726');
      const doc = await socketFor(doctor, a);

      const reportId = await onlyMessage(doc, 'reports', () => aReport(doctor, patientId));
      await onlyMessage(doc, 'reports', async () => {
        await request(app).post(`/api/v1/reports/${reportId}/review`).set(headersFor(doctor)).expect(200);
        return reportId;
      });
      // A second look changes nothing, so it says nothing.
      await request(app).post(`/api/v1/reports/${reportId}/review`).set(headersFor(doctor)).expect(200);
      await settle();
      expect(doc.changes('reports')).toHaveLength(2);
    });

    test('notifications: created and marked read', async () => {
      const { doctor, a, atA } = await aTwoLocationClinic('+92300727');
      const doc = await socketFor(doctor, a);

      // An assistant registering a patient is news to the doctor.
      await onlyMessage(doc, 'notifications', async () => {
        await aPatient(atA, a);
        return undefined;
      });
      await onlyMessage(doc, 'notifications', async () => {
        const inbox = await request(app).get('/api/v1/notifications').set(headersFor(doctor)).expect(200);
        await request(app)
          .post('/api/v1/notifications/read')
          .set(headersFor(doctor))
          .send({ ids: [inbox.body.data[0].id] })
          .expect(200);
        return undefined;
      });
    });

    test('team: a member added, their locations changed, removed', async () => {
      const { doctor, a, b } = await aTwoLocationClinic('+92300728');
      const doc = await socketFor(doctor, a);

      const membershipId = await onlyMessage(
        doc,
        'team',
        async () =>
          (
            await request(app)
              .post('/api/v1/members')
              .set(headersFor(doctor))
              .send({ phone: '+9230072805', name: 'Hina', role: 'pa', locationIds: [a] })
              .expect(201)
          ).body.data.id as string,
      );
      await onlyMessage(doc, 'team', async () => {
        await request(app)
          .patch(`/api/v1/members/${membershipId}`)
          .set(headersFor(doctor))
          .send({ locationIds: [a, b] })
          .expect(200);
        return membershipId;
      });
      await onlyMessage(doc, 'team', async () => {
        await request(app).delete(`/api/v1/members/${membershipId}`).set(headersFor(doctor)).expect(200);
        return membershipId;
      });
    });

    test('locations: added, edited, archived', async () => {
      const { doctor, a } = await aTwoLocationClinic('+92300729');
      const doc = await socketFor(doctor, a);

      const third = await onlyMessage(
        doc,
        'locations',
        async () =>
          (await request(app).post('/api/v1/locations').set(headersFor(doctor)).send({ name: 'C' }).expect(201)).body.data
            .id as string,
      );
      await onlyMessage(doc, 'locations', async () => {
        await request(app)
          .patch(`/api/v1/locations/${third}`)
          .set(headersFor(doctor))
          .send({ name: 'C, upstairs' })
          .expect(200);
        return third;
      });
      await onlyMessage(doc, 'locations', async () => {
        await request(app).post(`/api/v1/locations/${third}/archive`).set(headersFor(doctor)).expect(200);
        return third;
      });
    });

    test('voice: a segment applied, a segment failed', async () => {
      const { doctor, a, patientId } = await aTwoLocationClinic('+92300730');
      const draft = await aDraft(doctor, patientId, 'voice');
      const doc = await socketFor(doctor, a);

      await onlyMessage(doc, 'voice', async () => {
        await uploadSegment(doctor, draft.id, 1, APPLIES);
        return draft.id as string;
      });
      await onlyMessage(doc, 'voice', async () => {
        await uploadSegment(doctor, draft.id, 2, FAILS);
        return draft.id as string;
      });
    });
  });

  describe('closing a socket when access ends', () => {
    test("signing out closes that session's sockets and nobody else's", async () => {
      const { doctor } = await aClinic('+9230073111');
      const laptop = await signIn(doctor.phone, undefined, 'second-laptop');
      const [onPhone, onLaptop] = await Promise.all([
        socketFor(doctor, doctor.locationId),
        socketFor(laptop, doctor.locationId),
      ]);

      await request(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${laptop.accessToken}`)
        .send({ refreshToken: laptop.refreshToken })
        .expect(200);

      expect(await onLaptop.next(isError)).toMatchObject({ code: 'SESSION_REVOKED' });
      expect(await onLaptop.closed).toEqual({ code: 1008, reason: 'SESSION_REVOKED' });
      await settle();
      expect(onPhone.isOpen).toBe(true);
    });

    test('removing a member closes their sockets for that clinic, and the team hears it', async () => {
      const { doctor, a, atA } = await aTwoLocationClinic('+92300732');
      const [doc, desk, tablet] = await Promise.all([socketFor(doctor, a), socketFor(atA, a), socketFor(atA, a)]);
      const membershipId = await memberIdOf(doctor, atA);

      await request(app).delete(`/api/v1/members/${membershipId}`).set(headersFor(doctor)).expect(200);

      await Promise.all(
        [desk, tablet].map(async (client) => {
          expect(await client.closed).toEqual({ code: 1008, reason: 'MEMBERSHIP_REMOVED' });
          expect(client.inbox[client.inbox.length - 1]).toMatchObject({ type: 'error', code: 'MEMBERSHIP_REMOVED' });
          expect(client.changes('team')).toEqual([]);
        }),
      );
      expect(await doc.next(changed('team'))).toEqual({ type: 'changed', topic: 'team', id: membershipId });
      expect(doc.isOpen).toBe(true);
    });

    test('taking a location away from an assistant closes their socket there and keeps the rest', async () => {
      const { doctor, a, b, patientId } = await aTwoLocationClinic('+92300733');
      const atBoth = await aPa(doctor, '+9230073304', [a, b]);
      const [onA, onB] = await Promise.all([socketFor(atBoth, a), socketFor(atBoth, b)]);

      await request(app)
        .patch(`/api/v1/members/${await memberIdOf(doctor, atBoth)}`)
        .set(headersFor(doctor))
        .send({ locationIds: [b] })
        .expect(200);

      expect(await onA.next(isError)).toMatchObject({ code: 'LOCATION_NOT_ALLOWED' });
      expect(await onA.closed).toEqual({ code: 1008, reason: 'LOCATION_NOT_ALLOWED' });
      await onB.next(changed('team'));
      expect(onB.isOpen).toBe(true);

      // And patients are now decided by the new list: one only linked to A is no longer theirs to hear about.
      await request(app).patch(`/api/v1/patients/${patientId}`).set(headersFor(doctor)).send({ age: 41 }).expect(200);
      await settle();
      expect(onB.changes('patients')).toEqual([]);
    });

    test('archiving a location closes the sockets on it and nowhere else', async () => {
      const { doctor, a, b, atB } = await aTwoLocationClinic('+92300734');
      const [docAtB, deskAtB, docAtA] = await Promise.all([socketFor(doctor, b), socketFor(atB, b), socketFor(doctor, a)]);

      await request(app).post(`/api/v1/locations/${b}/archive`).set(headersFor(doctor)).expect(200);

      await Promise.all(
        [docAtB, deskAtB].map(async (client) => {
          expect(await client.closed).toEqual({ code: 1008, reason: 'LOCATION_ARCHIVED' });
          expect(client.inbox[client.inbox.length - 1]).toMatchObject({ type: 'error', code: 'LOCATION_ARCHIVED' });
        }),
      );
      expect(await docAtA.next(changed('locations'))).toEqual({ type: 'changed', topic: 'locations', id: b });
      expect(docAtA.isOpen).toBe(true);
    });

    test('making a doctor an assistant closes their sockets on locations they were not given', async () => {
      const { doctor, a, b } = await aTwoLocationClinic('+92300735');
      const added = await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+9230073505', name: 'Dr Second', role: 'doctor', locationIds: [a] })
        .expect(201);
      const colleague = await signIn('+9230073505');
      const [onA, onB] = await Promise.all([socketFor(colleague, a), socketFor(colleague, b)]);

      await request(app)
        .patch(`/api/v1/members/${added.body.data.id}`)
        .set(headersFor(doctor))
        .send({ role: 'pa' })
        .expect(200);

      expect(await onB.closed).toEqual({ code: 1008, reason: 'LOCATION_NOT_ALLOWED' });
      await onA.next(changed('team'));
      expect(onA.isOpen).toBe(true);
    });
  });

  describe('what crosses the wire', () => {
    test('no message carries a name, a phone or anything medical', async () => {
      const { doctor, a, atA } = await aTwoLocationClinic('+92300741');
      const [doc, hereA] = await Promise.all([socketFor(doctor, a), socketFor(atA, a)]);

      const patientId = (
        await request(app)
          .post('/api/v1/patients')
          .set(at(atA, a))
          .send({
            name: 'Zainab Qureshi',
            phone: '+923451112233',
            age: 52,
            sex: 'female',
            allergies: ['Penicillin'],
            conditions: ['Diabetes'],
          })
          .expect(201)
      ).body.data.id as string;
      const visitId = await aVisit(atA, a, patientId);
      await request(app)
        .put(`/api/v1/visits/${visitId}/vitals`)
        .set(at(atA, a))
        .send({ bp: '150/95', pulse: 101, complaints: 'Chest pain' })
        .expect(200);
      await aReport(doctor, patientId);
      const draft = await aDraft(doctor, patientId);
      await request(app)
        .patch(`/api/v1/prescriptions/${draft.id}`)
        .set(at(doctor, a))
        .send({ ops: [{ op: 'add', section: 'complaints', value: { text: 'Palpitations' } }] })
        .expect(200);
      await request(app).post(`/api/v1/prescriptions/${draft.id}/approve`).set(at(doctor, a)).expect(200);

      const topics: RealtimeTopic[] = ['patients', 'visits', 'vitals', 'reports', 'prescriptions', 'notifications'];
      await doc.until(() => topics.every((topic) => doc.changes(topic).length > 0));
      await settle();

      const wire = [...doc.frames, ...hereA.frames].join('\n');
      [
        'Zainab',
        'Qureshi',
        '+923451112233',
        '3451112233',
        'Penicillin',
        'Diabetes',
        '150/95',
        'Chest pain',
        'Palpitations',
      ].forEach((secret) => expect(wire).not.toContain(secret));
      [...doc.inbox, ...hereA.inbox].forEach(expectBare);
    });
  });
});
