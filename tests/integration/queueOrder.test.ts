import request from 'supertest';
import { Types } from 'mongoose';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, headersFor, signIn, type SignedIn } from '../fixtures/clinic.fixture';
import { AuditLog, Counter, Membership, Visit } from '../../src/models';
import { backfillQueuePositions } from '../../src/services/visit.service';
import { addDays, karachiDay, todayInKarachi } from '../../src/utils/time';

setupTestDB();

type Headers = Record<string, string>;

interface Row {
  id: string;
  token: number;
  queuePosition: number;
  status: string;
}

/** A new patient on a list: today's at the location in `headers`, unless a date is given. */
const aVisit = async (doctor: SignedIn, headers: Headers, name: string, date?: string): Promise<string> => {
  const patient = await request(app)
    .post('/api/v1/patients')
    .set(headersFor(doctor))
    .send({ name, age: 30, sex: 'female' })
    .expect(201);
  const visit = await request(app)
    .post('/api/v1/visits')
    .set(headers)
    .send({ patientId: patient.body.data.id, ...(date ? { date } : {}) })
    .expect(201);
  return visit.body.data.id as string;
};

/** A doctor's clinic with `count` patients on today's list, added one after another. */
const aList = async (phone: string, count: number) => {
  const { doctor } = await aClinic(phone);
  const headers = headersFor(doctor, { location: true });
  const ids: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    ids.push(await aVisit(doctor, headers, `Patient ${n}`));
  }
  return { doctor, headers, ids };
};

const theList = async (headers: Headers): Promise<Row[]> =>
  (await request(app).get('/api/v1/visits').set(headers).expect(200)).body.data as Row[];

const idsOf = (rows: Row[]): string[] => rows.map((row) => row.id);

const move = (headers: Headers, id: string, before: string | null) =>
  request(app).post(`/api/v1/visits/${id}/move`).set(headers).send({ before });

const setStatus = async (headers: Headers, id: string, status: string): Promise<void> => {
  await request(app).patch(`/api/v1/visits/${id}`).set(headers).send({ status }).expect(200);
};

/** A signed-in user holding the `patient` role, which no route lets you create. */
const aPatientRole = async (doctor: SignedIn, phone: string): Promise<Headers> => {
  const user = await signIn(phone);
  await Membership.create({
    userId: new Types.ObjectId(user.userId),
    practiceId: new Types.ObjectId(doctor.practiceId),
    role: 'patient',
    locationIds: [new Types.ObjectId(doctor.locationId)],
    status: 'active',
    addedBy: new Types.ObjectId(doctor.userId),
    createdBy: new Types.ObjectId(doctor.userId),
  });
  return {
    Authorization: `Bearer ${user.accessToken}`,
    'X-Practice-Id': doctor.practiceId,
    'X-Location-Id': doctor.locationId,
  };
};

describe("Rearranging today's list", () => {
  describe('the order', () => {
    test('a new visit goes to the end, and the list follows queuePosition rather than the token', async () => {
      const { doctor, headers, ids } = await aList('+923008880001', 3);
      const [a, b, c] = ids;

      const fresh = await theList(headers);
      expect(idsOf(fresh)).toEqual([a, b, c]);
      expect(fresh.map((row) => row.queuePosition)).toEqual([1, 2, 3]);

      await move(headers, c, a).expect(200);
      const reordered = await theList(headers);
      expect(idsOf(reordered)).toEqual([c, a, b]);
      expect(reordered.map((row) => row.token)).toEqual([3, 1, 2]);

      // Moved to the end, and still before whoever arrives next.
      await move(headers, a, null).expect(200);
      const d = await aVisit(doctor, headers, 'Patient 4');
      const after = await theList(headers);
      expect(idsOf(after)).toEqual([c, b, a, d]);

      const positions = after.map((row) => row.queuePosition);
      expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    });

    test('moves a visit just before another, keeps its token, and audits the old and new positions', async () => {
      const { headers, ids } = await aList('+923008880002', 3);
      const [a, b, c] = ids;

      const moved = await move(headers, c, b).expect(200);
      expect(moved.body.data).toMatchObject({ id: c, token: 3, status: 'waiting' });
      expect(moved.body.data.queuePosition).toBeGreaterThan(1);
      expect(moved.body.data.queuePosition).toBeLessThan(2);

      const list = await theList(headers);
      expect(idsOf(list)).toEqual([a, c, b]);
      expect(list.map((row) => row.token)).toEqual([1, 3, 2]);

      const entry = await AuditLog.findOne({ action: 'visit.move', entityId: new Types.ObjectId(c) });
      expect(entry).not.toBeNull();
      expect(entry!.before).toEqual({ queuePosition: 3 });
      expect(entry!.after).toEqual({ queuePosition: moved.body.data.queuePosition, movedBefore: b });
    });

    test('null moves a visit after every other waiting visit', async () => {
      const { headers, ids } = await aList('+923008880003', 3);
      const [a, b, c] = ids;

      const moved = await move(headers, a, null).expect(200);
      expect(moved.body.data.token).toBe(1);
      expect(idsOf(await theList(headers))).toEqual([b, c, a]);
    });

    test('a move to where the visit already is changes nothing', async () => {
      const { headers, ids } = await aList('+923008880004', 3);
      const [a, b, c] = ids;

      const already = await move(headers, a, b).expect(200);
      expect(already.body.data.queuePosition).toBe(1);
      const last = await move(headers, c, null).expect(200);
      expect(last.body.data.queuePosition).toBe(3);

      // Among the waiting, a is already right before c once b has gone in.
      await setStatus(headers, b, 'with_doctor');
      const skipping = await move(headers, a, c).expect(200);
      expect(skipping.body.data.queuePosition).toBe(1);

      const list = await theList(headers);
      expect(list.map((row) => row.queuePosition)).toEqual([1, 2, 3]);
      expect(await AuditLog.countDocuments({ action: 'visit.move' })).toBe(0);
    });

    test('renumbers the day when there is no room left between two visits', async () => {
      const { headers, ids } = await aList('+923008880005', 3);
      const [a, b, c] = ids;

      // The next number up from 1: nothing fits between the two.
      await Visit.updateOne({ _id: b }, { $set: { queuePosition: 1 + Number.EPSILON } });

      const moved = await move(headers, c, b).expect(200);
      expect(moved.body.data.queuePosition).toBe(2);

      const list = await theList(headers);
      expect(idsOf(list)).toEqual([a, c, b]);
      expect(list.map((row) => row.queuePosition)).toEqual([1, 2, 3]);
      expect(list.map((row) => row.token)).toEqual([1, 3, 2]);
    });
  });

  describe('what is refused', () => {
    test('a visit with the doctor or already seen does not move', async () => {
      const { headers, ids } = await aList('+923008880011', 3);
      const [a, b, c] = ids;
      await setStatus(headers, b, 'with_doctor');
      await setStatus(headers, c, 'done');

      const inside = await move(headers, b, a).expect(409);
      expect(inside.body.error.code).toBe('CONFLICT');
      expect(inside.body.error.details).toEqual({ visitId: b, status: 'with_doctor' });

      const seen = await move(headers, c, null).expect(409);
      expect(seen.body.error.code).toBe('CONFLICT');
      expect(seen.body.error.details).toEqual({ visitId: c, status: 'done' });

      expect(idsOf(await theList(headers))).toEqual([a, b, c]);
    });

    test('nothing moves before a visit that is not waiting', async () => {
      const { headers, ids } = await aList('+923008880012', 3);
      const [a, b, c] = ids;
      await setStatus(headers, a, 'with_doctor');

      const response = await move(headers, c, a).expect(409);
      expect(response.body.error.code).toBe('CONFLICT');
      expect(response.body.error.details).toEqual({ visitId: a, status: 'with_doctor' });
      expect(idsOf(await theList(headers))).toEqual([a, b, c]);
    });

    test('nothing moves before a visit on another day', async () => {
      const { doctor, headers, ids } = await aList('+923008880013', 2);
      const tomorrow = karachiDay(addDays(new Date(), 1));
      const later = await aVisit(doctor, headers, 'Tomorrow', tomorrow);

      const response = await move(headers, ids[1], later).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details[0].field).toBe('body.before');
    });

    test('nothing moves before a visit at another location', async () => {
      const { doctor, headers, ids } = await aList('+923008880014', 2);
      const branch = await request(app)
        .post('/api/v1/locations')
        .set(headersFor(doctor))
        .send({ name: 'Clifton branch' })
        .expect(201);
      const elsewhere = await aVisit(doctor, headersFor(doctor, { location: branch.body.data.id }), 'Elsewhere');

      const response = await move(headers, ids[1], elsewhere).expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });

    test('a visit does not move before itself', async () => {
      const { headers, ids } = await aList('+923008880015', 2);

      const response = await move(headers, ids[0], ids[0]).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details[0].field).toBe('body.before');
    });
  });

  describe('who may move a visit', () => {
    test('the doctor and the assistant may', async () => {
      const { doctor, headers, ids } = await aList('+923008880021', 3);
      const [a, b, c] = ids;
      const pa = await aPa(doctor, '+923008880022');

      await move(headers, c, a).expect(200);
      await move(headersFor(pa, { location: true }), a, null).expect(200);

      expect(idsOf(await theList(headers))).toEqual([c, b, a]);
    });

    test('a patient may not', async () => {
      const { doctor, headers, ids } = await aList('+923008880023', 2);
      const patientHeaders = await aPatientRole(doctor, '+923008880024');

      const response = await move(patientHeaders, ids[1], ids[0]).expect(403);
      expect(response.body.error.code).toBe('FORBIDDEN');
      expect(idsOf(await theList(headers))).toEqual(ids);
    });

    test('a visit from another clinic answers NOT_FOUND, as the visit or as the one to go before', async () => {
      const mine = await aList('+923008880025', 2);
      const theirs = await aList('+923008880026', 2);

      const theirVisit = await move(mine.headers, theirs.ids[1], null).expect(404);
      expect(theirVisit.body.error.code).toBe('NOT_FOUND');

      const theirAnchor = await move(mine.headers, mine.ids[1], theirs.ids[0]).expect(404);
      expect(theirAnchor.body.error.code).toBe('NOT_FOUND');
    });

    test('a visit at another location answers NOT_FOUND', async () => {
      const { doctor, headers } = await aList('+923008880027', 1);
      const branch = await request(app)
        .post('/api/v1/locations')
        .set(headersFor(doctor))
        .send({ name: 'Gulberg branch' })
        .expect(201);
      const branchHeaders = headersFor(doctor, { location: branch.body.data.id });
      const elsewhere = await aVisit(doctor, branchHeaders, 'Elsewhere');
      await aVisit(doctor, branchHeaders, 'Elsewhere too');

      const response = await move(headers, elsewhere, null).expect(404);
      expect(response.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('two people at once', () => {
    test('two moves at once both land where they asked, without sharing a position', async () => {
      const { headers, ids } = await aList('+923008880031', 4);
      const [a, b, c, d] = ids;

      const [first, second] = await Promise.all([move(headers, d, b), move(headers, c, b)]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const list = await theList(headers);
      expect(list[0].id).toBe(a);
      expect(list[3].id).toBe(b);
      expect(new Set([list[1].id, list[2].id])).toEqual(new Set([c, d]));
      expect(new Set(list.map((row) => row.queuePosition)).size).toBe(4);

      const [third, fourth] = await Promise.all([move(headers, a, null), move(headers, b, null)]);
      expect(third.status).toBe(200);
      expect(fourth.status).toBe(200);

      const ends = await theList(headers);
      expect(new Set([ends[2].id, ends[3].id])).toEqual(new Set([a, b]));
      expect(new Set(ends.map((row) => row.queuePosition)).size).toBe(4);
    });

    test('a move waits for one in progress, and a lease left by a move that died runs out', async () => {
      const { doctor, headers, ids } = await aList('+923008880032', 3);
      const [a, b, c] = ids;
      const practiceId = new Types.ObjectId(doctor.practiceId);
      const key = `visitQueue:${doctor.locationId}:${todayInKarachi()}`;

      // Somebody else is part way through rearranging this list.
      await Counter.create({ practiceId, key, seq: 7, lockedUntil: new Date(Date.now() + 60_000) });
      const busy = await move(headers, c, a).expect(409);
      expect(busy.body.error.code).toBe('CONFLICT');
      expect(idsOf(await theList(headers))).toEqual([a, b, c]);

      // ...and never finished: once its time is up the list is free again.
      await Counter.updateOne({ practiceId, key }, { $set: { lockedUntil: new Date(Date.now() - 1) } });
      await move(headers, c, a).expect(200);
      expect(idsOf(await theList(headers))).toEqual([c, a, b]);

      const lease = await Counter.findOne({ practiceId, key });
      expect(lease!.seq).toBe(8);
      expect(lease!.lockedUntil).toBeNull();
    });
  });

  describe('visits from before the order existed', () => {
    test('the backfill gives them their token order, and a second run does nothing', async () => {
      const { headers, ids } = await aList('+923008880041', 3);
      const [a, b, c] = ids;

      // As they were: no position, and created out of token order.
      await Visit.collection.updateMany({}, { $unset: { queuePosition: '' } });
      await Visit.collection.updateOne(
        { _id: new Types.ObjectId(a) },
        { $set: { createdAt: new Date(Date.now() + 60_000) } },
      );

      expect(await backfillQueuePositions()).toBe(3);
      const rows = await Visit.find({}).sort({ token: 1 });
      rows.forEach((row) => expect(row.queuePosition).toBe(row.token));
      expect(idsOf(await theList(headers))).toEqual([a, b, c]);

      expect(await backfillQueuePositions()).toBe(0);
    });
  });
});
