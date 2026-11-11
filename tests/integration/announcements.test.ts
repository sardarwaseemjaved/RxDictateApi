import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, aPlatformAdmin, headersFor, signIn, waitFor, type SignedIn } from '../fixtures/clinic.fixture';
import { signedIn, startLive, type Live, type LiveClient } from '../fixtures/realtime.fixture';
import { Announcement, AuditLog, Drug, Job, Location, Notification, User } from '../../src/models';
import { importDrugs } from '../../src/services/drugImport.service';
import { runDueJobs } from '../../src/services/job.service';
import { matchesAudience, type AudienceMember } from '../../src/services/announcementAudience.service';
import { announcementAudienceSchema } from '../../src/shared/announcement.schema';

setupTestDB();
jest.setTimeout(60_000);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (fromNowMs: number): string => new Date(Date.now() + fromNowMs).toISOString();

const UPDATE = {
  kind: 'update',
  title: 'Voice dictation is faster',
  body: 'Dictation now applies in half the time.',
  placements: ['today.banner', 'inbox.updates'],
  showFrom: at(-HOUR),
  showUntil: at(7 * DAY),
};

const SEMINAR = {
  kind: 'seminar',
  title: 'Managing hypertension',
  body: 'An evening seminar with Q&A.',
  cta: 'register',
  event: { startsAt: at(3 * DAY), place: 'Pearl Continental, Lahore' },
  placements: ['sidebar.card', 'inbox.updates'],
  showFrom: at(-HOUR),
  showUntil: at(3 * DAY),
};

/** Somebody added to the platform by its admin, then signed in. */
const aPlatformMember = async (platformAdmin: SignedIn, phone: string, role: string): Promise<SignedIn> => {
  await request(app).post('/api/v1/members').set(headersFor(platformAdmin)).send({ phone, role }).expect(201);
  return signIn(phone);
};

const aCompany = async (platformAdmin: SignedIn, phone: string, name = 'Acme Pharma') => {
  const created = await request(app)
    .post('/api/v1/companies')
    .set(headersFor(platformAdmin))
    .send({ name, secpRegNo: `SECP-${phone}`, drapLicenceNo: `DL-${phone}`, admin: { phone } })
    .expect(201);
  return { company: created.body.data as { id: string; name: string }, companyAdmin: await signIn(phone) };
};

/** Where a clinic's first location is. */
const placeClinic = async (actor: SignedIn, city: string | null, province: string | null) =>
  Location.updateOne({ _id: actor.locationId }, { $set: { city, province } });

/** A draft, then published. Answers its id. */
const publish = async (author: SignedIn, body: object): Promise<string> => {
  const created = await request(app).post('/api/v1/announcements').set(headersFor(author)).send(body).expect(201);
  const { id } = created.body.data;
  await request(app).post(`/api/v1/announcements/${id}/publish`).set(headersFor(author)).expect(200);
  return id as string;
};

const slots = async (actor: SignedIn, placement: string, location = false): Promise<{ id: string; title: string }[]> =>
  (
    await request(app)
      .get('/api/v1/announcements/slots')
      .query({ placement })
      .set(headersFor(actor, { location }))
      .expect(200)
  ).body.data;

const titlesIn = async (actor: SignedIn, placement = 'inbox.updates'): Promise<string[]> =>
  (await slots(actor, placement)).map((slot) => slot.title);

const event = (actor: SignedIn, id: string, type: string) =>
  request(app).post(`/api/v1/announcements/${id}/events`).set(headersFor(actor)).send({ type });

/** RxDictate's admin and content manager, and one clinic. */
const theCast = async (base: number) => {
  const platformAdmin = await aPlatformAdmin(`+9230188${base}01`);
  const contentManager = await aPlatformMember(platformAdmin, `+9230188${base}02`, 'contentManager');
  const { doctor } = await aClinic(`+9230188${base}03`);
  return { platformAdmin, contentManager, doctor };
};

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

describe('Permissions', () => {
  test("only RxDictate's admin and content manager write, publish and read registrations; `can` says so", async () => {
    const { platformAdmin, contentManager, doctor } = await theCast(10);
    const reviewer = await aPlatformMember(platformAdmin, '+923018810099', 'reviewer');
    const { companyAdmin } = await aCompany(platformAdmin, '+923018810098');

    const id = await publish(contentManager, SEMINAR);
    await request(app).get('/api/v1/announcements').set(headersFor(platformAdmin)).expect(200);

    await request(app).get('/api/v1/announcements').set(headersFor(reviewer)).expect(403);
    await request(app).post('/api/v1/announcements').set(headersFor(reviewer)).send(UPDATE).expect(403);
    await request(app).get(`/api/v1/announcements/${id}/registrations`).set(headersFor(reviewer)).expect(403);
    await request(app).post('/api/v1/announcements').set(headersFor(doctor)).send(UPDATE).expect(403);
    await request(app).post('/api/v1/announcements').set(headersFor(companyAdmin)).send(UPDATE).expect(403);
    // A company sees nothing meant for clinics.
    await request(app)
      .get('/api/v1/announcements/slots')
      .query({ placement: 'inbox.updates' })
      .set(headersFor(companyAdmin))
      .expect(403);
    await request(app)
      .get('/api/v1/announcements/slots')
      .query({ placement: 'inbox.updates' })
      .set(headersFor(reviewer))
      .expect(403);

    const canOf = async (actor: SignedIn): Promise<string[]> =>
      (
        await request(app)
          .get('/api/v1/me')
          .set({ Authorization: `Bearer ${actor.accessToken}` })
          .expect(200)
      ).body.data.memberships[0].can;
    expect(await canOf(contentManager)).toEqual(
      expect.arrayContaining([
        'announcement.read',
        'announcement.create',
        'announcement.publish',
        'announcement.registrations.read',
      ]),
    );
    expect(await canOf(reviewer)).not.toContain('announcement.read');
    expect(await canOf(doctor)).toContain('announcement.view');
    expect(await canOf(doctor)).not.toContain('announcement.create');
  });

  test('the rules between fields are enforced, and a product names an active national medicine and a sponsor', async () => {
    const { platformAdmin, contentManager, doctor } = await theCast(11);
    const { company } = await aCompany(platformAdmin, '+923018811099');
    await importDrugs(
      ['registrationNo,brand,composition,strength,form,pack,company', 'R-1,Zentra,Zentramol,250mg,Tablet,10x10,Acme'].join(
        '\n',
      ),
    );
    const drug = (await Drug.findOne({ drapRegNo: 'R-1' }))!;
    const post = (body: object) => request(app).post('/api/v1/announcements').set(headersFor(contentManager)).send(body);

    await post({ ...UPDATE, cta: 'register' }).expect(400);
    await post({ ...SEMINAR, event: null }).expect(400);
    await post({ ...SEMINAR, event: { startsAt: at(DAY) } }).expect(400);
    await post({ ...UPDATE, link: 'http://example.com' }).expect(400);
    await post({ ...UPDATE, showUntil: at(-2 * HOUR) }).expect(400);
    await post({ ...UPDATE, placements: [] }).expect(400);
    await post({ ...UPDATE, kind: 'product', drugId: String(drug._id) }).expect(400);
    await post({ ...UPDATE, sponsorId: doctor.practiceId }).expect(400);
    await post({ ...UPDATE, imageKey: `${doctor.practiceId}/reports/pages/${'a'.repeat(24)}.png` }).expect(400);
    await post({ ...UPDATE, audience: { roles: ['patient'] } }).expect(400);
    await post({ ...UPDATE, audience: { organisationIds: [company.id] } }).expect(400);

    const product = await post({ ...UPDATE, kind: 'product', drugId: String(drug._id), sponsorId: company.id }).expect(201);
    expect(product.body.data).toMatchObject({
      status: 'draft',
      isSponsored: true,
      sponsor: { id: company.id, name: 'Acme Pharma' },
      product: { id: String(drug._id), brand: 'Zentra', strength: '250mg' },
    });
    expect(await AuditLog.countDocuments({ action: 'announcement.create' })).toBe(1);

    // An edit is checked as the whole it leaves.
    await request(app)
      .patch(`/api/v1/announcements/${product.body.data.id}`)
      .set(headersFor(contentManager))
      .send({ sponsorId: null })
      .expect(400);
  });
});

/* ------------------------------------------------------------------ *
 * Audience
 * ------------------------------------------------------------------ */

describe('Audience', () => {
  const someone: AudienceMember = {
    userId: 'u1',
    organisationId: 'o1',
    role: 'doctor',
    specialties: ['paediatrics'],
    locations: [{ province: 'punjab', city: 'Lahore' }],
  };
  const audience = (fields: object) => announcementAudienceSchema.parse(fields);

  test('every filled list must match, an empty one matches everyone, and only clinic roles ever match', () => {
    expect(matchesAudience(audience({}), someone)).toBe(true);
    expect(matchesAudience(audience({ roles: ['doctor'], cities: ['lahore'] }), someone)).toBe(true);
    expect(matchesAudience(audience({ roles: ['pa'] }), someone)).toBe(false);
    expect(matchesAudience(audience({ specialties: ['paediatrics', 'cardiology'] }), someone)).toBe(true);
    expect(matchesAudience(audience({ specialties: ['cardiology'] }), someone)).toBe(false);
    expect(matchesAudience(audience({ provinces: ['sindh'] }), someone)).toBe(false);
    expect(matchesAudience(audience({ provinces: ['punjab'], cities: ['Karachi'] }), someone)).toBe(false);
    expect(matchesAudience(audience({ organisationIds: ['0123456789abcdef01234567'] }), someone)).toBe(false);
    expect(matchesAudience(audience({}), { ...someone, role: 'patient' })).toBe(false);
    expect(matchesAudience(audience({}), { ...someone, role: 'companyAdmin' })).toBe(false);
    expect(matchesAudience(audience({ cities: ['Lahore'] }), { ...someone, locations: [] })).toBe(false);
  });

  test("slots match the member's role, specialty and location, and the count agrees", async () => {
    const { contentManager, doctor } = await theCast(20);
    const pa = await aPa(doctor, '+923018820010');
    const { doctor: karachi } = await aClinic('+923018820020');
    const { doctor: other } = await aClinic('+923018820030');
    await placeClinic(doctor, 'Lahore', 'punjab');
    await placeClinic(karachi, 'Karachi', 'sindh');
    await User.updateOne({ _id: doctor.userId }, { $set: { specialties: ['paediatrics'] } });
    await User.updateOne({ _id: karachi.userId }, { $set: { specialties: ['paediatrics'] } });

    await publish(contentManager, { ...UPDATE, title: 'Everyone' });
    await publish(contentManager, {
      ...UPDATE,
      title: 'Lahore doctors',
      audience: { roles: ['doctor'], cities: ['Lahore'] },
    });
    await publish(contentManager, { ...UPDATE, title: 'Paediatrics', audience: { specialties: ['paediatrics'] } });
    await publish(contentManager, { ...UPDATE, title: 'Assistants', audience: { roles: ['pa'] } });
    await publish(contentManager, {
      ...UPDATE,
      title: 'One clinic',
      audience: { organisationIds: [other.practiceId] },
    });
    await publish(contentManager, { ...UPDATE, title: 'One person', audience: { userIds: [pa.userId] } });

    const sorted = async (actor: SignedIn) => (await titlesIn(actor)).sort();
    expect(await sorted(doctor)).toEqual(['Everyone', 'Lahore doctors', 'Paediatrics']);
    expect(await sorted(pa)).toEqual(['Assistants', 'Everyone', 'One person']);
    expect(await sorted(karachi)).toEqual(['Everyone', 'Paediatrics']);
    expect(await sorted(other)).toEqual(['Everyone', 'One clinic']);

    const count = async (fields: object): Promise<number> =>
      (
        await request(app)
          .post('/api/v1/announcements/audience-count')
          .set(headersFor(contentManager))
          .send({ audience: fields })
          .expect(200)
      ).body.data.users;
    expect(await count({})).toBe(4);
    expect(await count({ roles: ['doctor'], cities: ['Lahore'] })).toBe(1);
    expect(await count({ specialties: ['paediatrics'] })).toBe(2);
    expect(await count({ roles: ['pa'] })).toBe(1);
    expect(await count({ provinces: ['sindh'] })).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * What a slot shows
 * ------------------------------------------------------------------ */

describe('Slots', () => {
  test('only published ones inside their window show, by priority then newest, one at a time in a banner', async () => {
    const { contentManager, doctor } = await theCast(30);
    const draft = await request(app)
      .post('/api/v1/announcements')
      .set(headersFor(contentManager))
      .send({ ...UPDATE, title: 'Draft' })
      .expect(201);
    await publish(contentManager, { ...UPDATE, title: 'Later', showFrom: at(DAY) });
    await publish(contentManager, { ...UPDATE, title: 'Old' });
    await publish(contentManager, { ...UPDATE, title: 'New' });
    await publish(contentManager, { ...UPDATE, title: 'Urgent', priority: 10 });
    const gone = await publish(contentManager, { ...UPDATE, title: 'Withdrawn' });
    await request(app).post(`/api/v1/announcements/${gone}/withdraw`).set(headersFor(contentManager)).expect(200);
    await request(app).post(`/api/v1/announcements/${gone}/withdraw`).set(headersFor(contentManager)).expect(409);

    expect(await titlesIn(doctor)).toEqual(['Urgent', 'New', 'Old']);
    expect(await titlesIn(doctor, 'today.banner')).toEqual(['Urgent']);
    expect(await titlesIn(doctor, 'sidebar.card')).toEqual([]);
    expect(draft.body.data.status).toBe('draft');

    // Its window passes: it stops showing, and the console says it ended.
    const urgent = (await slots(doctor, 'today.banner'))[0].id;
    await request(app)
      .patch(`/api/v1/announcements/${urgent}`)
      .set(headersFor(contentManager))
      .send({ showFrom: at(-2 * DAY), showUntil: at(-1000) })
      .expect(200);
    expect(await titlesIn(doctor, 'today.banner')).toEqual(['New']);
    const ended = await request(app).get(`/api/v1/announcements/${urgent}`).set(headersFor(contentManager)).expect(200);
    expect(ended.body.data).toMatchObject({ status: 'published', ended: true });
    expect(ended.body.data.history.map((entry: { step: string }) => entry.step)).toEqual(['created', 'published', 'edited']);
    expect(ended.body.data.history[2].fields.sort()).toEqual(['showFrom', 'showUntil']);
  });

  test('a cap counts what was shown, and a dismissed one never comes back', async () => {
    const { contentManager, doctor } = await theCast(31);
    const capped = await publish(contentManager, { ...UPDATE, title: 'Twice', maxShows: 2 });
    const dismissed = await publish(contentManager, { ...UPDATE, title: 'Until dismissed' });

    await event(doctor, capped, 'shown').expect(200);
    expect(await titlesIn(doctor)).toEqual(['Until dismissed', 'Twice']);
    const second = await event(doctor, capped, 'shown').expect(200);
    expect(second.body.data).toEqual({ shows: 2, dismissed: false, reminded: false, registered: false });
    expect(await titlesIn(doctor)).toEqual(['Until dismissed']);

    await event(doctor, dismissed, 'dismissed').expect(200);
    await event(doctor, dismissed, 'dismissed').expect(200);
    expect(await titlesIn(doctor)).toEqual([]);
    await event(doctor, dismissed, 'nonsense').expect(400);
  });

  test("sponsored ones follow the setting, which a clinic can turn off and lock; RxDictate's own still show", async () => {
    const { platformAdmin, contentManager, doctor } = await theCast(32);
    const pa = await aPa(doctor, '+923018832010');
    const { company } = await aCompany(platformAdmin, '+923018832099');
    await publish(contentManager, { ...UPDATE, title: 'Ours' });
    await publish(contentManager, { ...UPDATE, title: 'Sponsored', sponsorId: company.id });

    const sponsored = (await slots(doctor, 'inbox.updates')).find((slot) => slot.title === 'Sponsored');
    expect(sponsored).toMatchObject({ isSponsored: true, sponsor: { id: company.id, name: 'Acme Pharma' } });

    const set = (actor: SignedIn, layer: 'me' | 'organisation', value: boolean, locked?: boolean) =>
      request(app)
        .patch(`/api/v1/settings/${layer}`)
        .set(headersFor(actor))
        .send({ values: [{ key: 'announcements.sponsored', value, ...(locked === undefined ? {} : { locked }) }] });

    await set(pa, 'me', false).expect(200);
    expect((await titlesIn(pa)).sort()).toEqual(['Ours']);
    expect((await titlesIn(doctor)).sort()).toEqual(['Ours', 'Sponsored']);

    // The clinic turns it off for everyone and locks it; nobody in it can turn it back on.
    await set(pa, 'me', true).expect(200);
    await set(doctor, 'organisation', false, true).expect(200);
    await set(pa, 'me', true).expect(400);
    expect(await titlesIn(pa)).toEqual(['Ours']);
    expect(await titlesIn(doctor)).toEqual(['Ours']);
    // A PA cannot set the clinic's.
    await set(pa, 'organisation', true).expect(403);
  });
});

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

describe('Reminders', () => {
  test('a day and an hour before, skipping a time already past; cancelled by the member or by withdrawing', async () => {
    const { contentManager, doctor } = await theCast(40);
    const pa = await aPa(doctor, '+923018840010');
    const seminar = await publish(contentManager, SEMINAR);
    const soon = await publish(contentManager, {
      ...SEMINAR,
      title: 'Soon',
      event: { startsAt: at(2 * HOUR), onlineUrl: 'https://meet.example.com/x' },
      showUntil: at(2 * HOUR),
    });

    const reminded = await request(app)
      .post(`/api/v1/announcements/${seminar}/reminder`)
      .set(headersFor(doctor))
      .expect(200);
    expect(reminded.body.data).toMatchObject({ reminded: true });
    await request(app).post(`/api/v1/announcements/${seminar}/reminder`).set(headersFor(doctor)).expect(200);
    const jobs = await Job.find({ refId: seminar, userId: doctor.userId, status: 'pending' }).sort({ runAt: 1 });
    expect(jobs.map((job) => job.data.lead)).toEqual(['day', 'hour']);
    expect(String(jobs[0].practiceId)).toBe(doctor.practiceId);

    await request(app).post(`/api/v1/announcements/${soon}/reminder`).set(headersFor(doctor)).expect(200);
    expect((await Job.find({ refId: soon, status: 'pending' })).map((job) => job.data.lead)).toEqual(['hour']);

    const slot = (await slots(doctor, 'sidebar.card'))[0];
    expect(slot).toMatchObject({ id: soon, reminded: true });

    // Cancelled by the member.
    await request(app).delete(`/api/v1/announcements/${soon}/reminder`).set(headersFor(doctor)).expect(200);
    expect(await Job.countDocuments({ refId: soon, status: 'pending' })).toBe(0);
    expect(await Job.countDocuments({ refId: soon, status: 'cancelled' })).toBe(1);

    // Cancelled for everyone by withdrawing.
    await request(app).post(`/api/v1/announcements/${seminar}/reminder`).set(headersFor(pa)).expect(200);
    expect(await Job.countDocuments({ refId: seminar, status: 'pending' })).toBe(4);
    await request(app).post(`/api/v1/announcements/${seminar}/withdraw`).set(headersFor(contentManager)).expect(200);
    expect(await Job.countDocuments({ refId: seminar, status: 'pending' })).toBe(0);
    const refused = await request(app).post(`/api/v1/announcements/${seminar}/reminder`).set(headersFor(doctor)).expect(409);
    expect(refused.body.error.code).toBe('ANNOUNCEMENT_WITHDRAWN');

    expect(await AuditLog.countDocuments({ action: 'announcement.reminder.set' })).toBe(3);
  });

  test('only a seminar or an event takes one, and not once it has ended', async () => {
    const { contentManager, doctor } = await theCast(41);
    const update = await publish(contentManager, UPDATE);
    const notEvent = await request(app).post(`/api/v1/announcements/${update}/reminder`).set(headersFor(doctor)).expect(409);
    expect(notEvent.body.error.code).toBe('ANNOUNCEMENT_NOT_AN_EVENT');

    const seminar = await publish(contentManager, SEMINAR);
    await request(app)
      .patch(`/api/v1/announcements/${seminar}`)
      .set(headersFor(contentManager))
      .send({ showFrom: at(-2 * DAY), showUntil: at(-1000) })
      .expect(200);
    const ended = await request(app).post(`/api/v1/announcements/${seminar}/reminder`).set(headersFor(doctor)).expect(409);
    expect(ended.body.error.code).toBe('ANNOUNCEMENT_ENDED');
  });

  test('the sweep sends each due reminder to the bell once, and moving the event moves its reminders', async () => {
    const { contentManager, doctor } = await theCast(42);
    const seminar = await publish(contentManager, SEMINAR);
    await request(app).post(`/api/v1/announcements/${seminar}/reminder`).set(headersFor(doctor)).expect(200);

    // Moved a day later: the reminders follow.
    const startsAt = new Date(Date.now() + 4 * DAY);
    await request(app)
      .patch(`/api/v1/announcements/${seminar}`)
      .set(headersFor(contentManager))
      .send({
        event: { startsAt: startsAt.toISOString(), place: 'Pearl Continental, Lahore' },
        showUntil: startsAt.toISOString(),
      })
      .expect(200);
    const pending = await Job.find({ refId: seminar, status: 'pending' }).sort({ runAt: 1 });
    expect(pending.map((job) => job.runAt.getTime())).toEqual([startsAt.getTime() - DAY, startsAt.getTime() - HOUR]);

    // Nothing is due yet.
    expect(await runDueJobs()).toBe(0);

    // A day before: the first one goes.
    expect(await runDueJobs(new Date(startsAt.getTime() - DAY + 1000))).toBe(1);
    const inbox = await waitFor(
      () => Notification.find({ userId: doctor.userId, type: 'announcement.reminder' }),
      (found) => found.length === 1,
    );
    expect(inbox[0]).toMatchObject({ title: 'Managing hypertension', refId: expect.anything() });
    expect(inbox[0].body).toMatch(/^Starts tomorrow at \d{1,2}:\d{2} (am|pm), Pearl Continental, Lahore\.$/);
    expect(String(inbox[0].practiceId)).toBe(doctor.practiceId);

    // Run again at the same moment: nothing twice.
    expect(await runDueJobs(new Date(startsAt.getTime() - DAY + 2000))).toBe(0);

    // An hour before: the second.
    expect(await runDueJobs(new Date(startsAt.getTime() - HOUR + 1000))).toBe(1);
    await waitFor(
      () => Notification.countDocuments({ userId: doctor.userId, type: 'announcement.reminder' }),
      (count) => count === 2,
    );
    expect(await Job.countDocuments({ refId: seminar, status: 'done' })).toBe(2);

    const visible = await request(app).get('/api/v1/notifications').set(headersFor(doctor)).expect(200);
    expect(visible.body.data.filter((one: { type: string }) => one.type === 'announcement.reminder')).toHaveLength(2);
  });

  test('a reminder for one that was withdrawn after it fell due is skipped, not sent', async () => {
    const { contentManager, doctor } = await theCast(43);
    const seminar = await publish(contentManager, SEMINAR);
    await request(app).post(`/api/v1/announcements/${seminar}/reminder`).set(headersFor(doctor)).expect(200);
    const job = (await Job.findOne({ refId: seminar, status: 'pending' }).sort({ runAt: 1 }))!;
    // Withdrawn behind the jobs' back: the sweep still checks.
    await Announcement.updateOne({ _id: seminar }, { $set: { status: 'withdrawn' } });
    expect(await runDueJobs(new Date(job.runAt.getTime() + 1000))).toBe(0);
    expect((await Job.findById(job._id))?.status).toBe('skipped');
  });
});

/* ------------------------------------------------------------------ *
 * Registering
 * ------------------------------------------------------------------ */

describe('Registering', () => {
  test('needs consent, happens once, reaches the organiser as a list and a CSV, and can be taken back', async () => {
    const { contentManager, doctor } = await theCast(50);
    const seminar = await publish(contentManager, SEMINAR);
    const registerAs = (actor: SignedIn, body: object) =>
      request(app).post(`/api/v1/announcements/${seminar}/register`).set(headersFor(actor)).send(body);

    await registerAs(doctor, {}).expect(400);
    await registerAs(doctor, { consent: false }).expect(400);
    await registerAs(doctor, { consent: 'yes' }).expect(400);
    const registered = await registerAs(doctor, { consent: true }).expect(200);
    expect(registered.body.data).toMatchObject({ registered: true });
    await registerAs(doctor, { consent: true }).expect(200);

    const list = await request(app)
      .get(`/api/v1/announcements/${seminar}/registrations`)
      .set(headersFor(contentManager))
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      userId: doctor.userId,
      name: 'Dr Ayesha',
      phone: doctor.phone,
      clinic: { id: doctor.practiceId },
    });

    const csv = await request(app)
      .get(`/api/v1/announcements/${seminar}/registrations.csv`)
      .set(headersFor(contentManager))
      .expect(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toContain(`registrations-${seminar}.csv`);
    const [header, row] = csv.text.trim().split('\r\n');
    expect(header).toBe('Name,Phone,Clinic,Registered (Pakistan time)');
    expect(row.startsWith(`Dr Ayesha,${doctor.phone},`)).toBe(true);

    expect((await slots(doctor, 'sidebar.card'))[0]).toMatchObject({ id: seminar, registered: true });

    await request(app).delete(`/api/v1/announcements/${seminar}/register`).set(headersFor(doctor)).expect(200);
    const after = await request(app)
      .get(`/api/v1/announcements/${seminar}/registrations`)
      .set(headersFor(contentManager))
      .expect(200);
    expect(after.body.data).toEqual([]);
    expect(await AuditLog.countDocuments({ action: { $in: ['announcement.register', 'announcement.unregister'] } })).toBe(2);
  });

  test('refused on what is not an event, on a withdrawn one, and on one meant for others', async () => {
    const { contentManager, doctor } = await theCast(51);
    const { doctor: other } = await aClinic('+923018851099');
    const update = await publish(contentManager, UPDATE);
    const forOthers = await publish(contentManager, { ...SEMINAR, audience: { organisationIds: [other.practiceId] } });
    const seminar = await publish(contentManager, SEMINAR);
    await request(app).post(`/api/v1/announcements/${seminar}/withdraw`).set(headersFor(contentManager)).expect(200);

    const code = async (id: string) =>
      (await request(app).post(`/api/v1/announcements/${id}/register`).set(headersFor(doctor)).send({ consent: true })).body
        .error.code;
    expect(await code(update)).toBe('ANNOUNCEMENT_NOT_AN_EVENT');
    expect(await code(seminar)).toBe('ANNOUNCEMENT_WITHDRAWN');
    expect(await code(forOthers)).toBe('NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ *
 * Measurement
 * ------------------------------------------------------------------ */

describe('Stats', () => {
  test('are totals only, never who', async () => {
    const { contentManager, doctor } = await theCast(60);
    const pa = await aPa(doctor, '+923018860010');
    const seminar = await publish(contentManager, SEMINAR);

    await event(doctor, seminar, 'shown').expect(200);
    await event(doctor, seminar, 'shown').expect(200);
    await event(pa, seminar, 'shown').expect(200);
    await event(doctor, seminar, 'clicked').expect(200);
    await event(pa, seminar, 'dismissed').expect(200);
    await request(app).post(`/api/v1/announcements/${seminar}/reminder`).set(headersFor(doctor)).expect(200);
    await request(app)
      .post(`/api/v1/announcements/${seminar}/register`)
      .set(headersFor(doctor))
      .send({ consent: true })
      .expect(200);

    const stats = await request(app)
      .get(`/api/v1/announcements/${seminar}/stats`)
      .set(headersFor(contentManager))
      .expect(200);
    expect(stats.body.data).toEqual({ shows: 3, clicks: 1, dismissals: 1, reminders: 1, registrations: 1 });
    expect(JSON.stringify(stats.body.data)).not.toContain(doctor.userId);

    const view = await request(app).get(`/api/v1/announcements/${seminar}`).set(headersFor(contentManager)).expect(200);
    expect(JSON.stringify(view.body.data)).not.toContain(doctor.userId);
  });
});

/* ------------------------------------------------------------------ *
 * Live updates
 * ------------------------------------------------------------------ */

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

  test('clinic apps hear `announcements` when one is published, edited or withdrawn; a company does not', async () => {
    const { platformAdmin, contentManager, doctor } = await theCast(70);
    const { companyAdmin } = await aCompany(platformAdmin, '+923018870099');
    const clinicSocket = await signedIn(live.url, doctor, doctor.locationId);
    const companySocket = await signedIn(live.url, companyAdmin);
    opened.push(clinicSocket, companySocket);

    const draft = await request(app).post('/api/v1/announcements').set(headersFor(contentManager)).send(UPDATE).expect(201);
    const { id } = draft.body.data;

    // A draft's edits say nothing.
    await request(app)
      .patch(`/api/v1/announcements/${id}`)
      .set(headersFor(contentManager))
      .send({ priority: 3 })
      .expect(200);

    const times = (client: LiveClient) => client.changes('announcements').filter((message) => message.id === id).length;
    await request(app).post(`/api/v1/announcements/${id}/publish`).set(headersFor(contentManager)).expect(200);
    await clinicSocket.until(() => times(clinicSocket) === 1);
    await request(app)
      .patch(`/api/v1/announcements/${id}`)
      .set(headersFor(contentManager))
      .send({ priority: 5 })
      .expect(200);
    await clinicSocket.until(() => times(clinicSocket) === 2);
    await request(app).post(`/api/v1/announcements/${id}/withdraw`).set(headersFor(contentManager)).expect(200);
    await clinicSocket.until(() => times(clinicSocket) === 3);
    expect(times(companySocket)).toBe(0);
  });
});
