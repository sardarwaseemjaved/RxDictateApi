import request from 'supertest';
import { Types } from 'mongoose';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, aPlatformAdmin, headersFor, signIn, type SignedIn } from '../fixtures/clinic.fixture';
import { signedIn, startLive, type Live, type LiveClient } from '../fixtures/realtime.fixture';
import {
  Announcement,
  AnnouncementState,
  AuditLog,
  Drug,
  Location,
  Membership,
  Practice,
  Submission,
  User,
  drugKeys,
} from '../../src/models';
import { publishAnnouncement } from '../../src/services/announcement.service';
import { companyAnnouncementViewSchema } from '../../src/shared/announcement.schema';
import { karachiMonth, karachiMonthRange } from '../../src/utils/time';

setupTestDB();
jest.setTimeout(60_000);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (fromNowMs: number): string => new Date(Date.now() + fromNowMs).toISOString();

/** What a company sends: no sponsor, slots, priority or cap. */
const NEWS = {
  kind: 'update',
  title: 'Zentra now in packs of 30',
  body: 'The same tablet, in a larger pack.',
  showFrom: at(-HOUR),
  showUntil: at(7 * DAY),
};

/** What the console writes. */
const CONSOLE = { ...NEWS, title: 'From RxDictate', placements: ['inbox.updates'] };

/** Phones in the shape a Pakistani mobile has, so a local `03…` number maps onto them. */
const phone = (base: number, n: number): string => `+92302${base}0000${n}`;
const local = (e164: string): string => `0${e164.slice(3)}`;

const aPlatformMember = async (platformAdmin: SignedIn, number: string, role: string): Promise<SignedIn> => {
  await request(app).post('/api/v1/members').set(headersFor(platformAdmin)).send({ phone: number, role }).expect(201);
  return signIn(number);
};

const aCompany = async (platformAdmin: SignedIn, number: string, name = 'Acme Pharma') => {
  const created = await request(app)
    .post('/api/v1/companies')
    .set(headersFor(platformAdmin))
    .send({
      name,
      secpRegNo: `SECP-${number}`,
      drapLicenceNo: `DL-${number}`,
      admin: { phone: number, name: `${name} Admin` },
    })
    .expect(201);
  return { company: created.body.data as { id: string; name: string }, companyAdmin: await signIn(number) };
};

const aCompanyEditor = async (companyAdmin: SignedIn, number: string): Promise<SignedIn> => {
  await request(app)
    .post('/api/v1/members')
    .set(headersFor(companyAdmin))
    .send({ phone: number, role: 'companyEditor' })
    .expect(201);
  return signIn(number);
};

/** RxDictate's admin and content manager, one company with its admin and an editor, and one clinic. */
const theCast = async (base: number) => {
  const platformAdmin = await aPlatformAdmin(phone(base, 1));
  const contentManager = await aPlatformMember(platformAdmin, phone(base, 2), 'contentManager');
  const { company, companyAdmin } = await aCompany(platformAdmin, phone(base, 3));
  const companyEditor = await aCompanyEditor(companyAdmin, phone(base, 4));
  const { doctor } = await aClinic(phone(base, 5), 'Dr Imran Qureshi');
  return { platformAdmin, contentManager, company, companyAdmin, companyEditor, doctor };
};

/** An active national medicine owned by a company. */
const aProduct = async (companyId: string, brand = 'Zentra', status: 'active' | 'discontinued' = 'active') => {
  const values = { brand, generic: 'Zentramol 250mg', strength: '250mg', form: 'tab' as const };
  return Drug.create({
    source: 'company',
    scope: 'national',
    status,
    companyId: new Types.ObjectId(companyId),
    ...values,
    ...drugKeys(values),
  });
};

const send = (sender: SignedIn, body: object) =>
  request(app).post('/api/v1/company/announcements').set(headersFor(sender)).send(body);

const approve = (reviewer: SignedIn, id: string) =>
  request(app).post(`/api/v1/submissions/${id}/approve`).set(headersFor(reviewer)).send({});

/** A draft written in the console, then published. Answers its id. */
const published = async (author: SignedIn, body: object): Promise<string> => {
  const created = await request(app).post('/api/v1/announcements').set(headersFor(author)).send(body).expect(201);
  await request(app).post(`/api/v1/announcements/${created.body.data.id}/publish`).set(headersFor(author)).expect(200);
  return created.body.data.id as string;
};

const draft = async (author: SignedIn, body: object): Promise<string> =>
  (await request(app).post('/api/v1/announcements').set(headersFor(author)).send(body).expect(201)).body.data.id;

const publish = (author: SignedIn, id: string) =>
  request(app).post(`/api/v1/announcements/${id}/publish`).set(headersFor(author));

const event = (actor: SignedIn, id: string, type: string) =>
  request(app).post(`/api/v1/announcements/${id}/events`).set(headersFor(actor)).send({ type }).expect(200);

const titlesIn = async (actor: SignedIn): Promise<string[]> =>
  (
    await request(app)
      .get('/api/v1/announcements/slots')
      .query({ placement: 'inbox.updates' })
      .set(headersFor(actor))
      .expect(200)
  ).body.data.map((slot: { title: string }) => slot.title);

const setAllowance = (
  platformAdmin: SignedIn,
  companyId: string,
  postsPerMonth: number | null,
  peoplePerPost: number | null,
) =>
  request(app)
    .patch(`/api/v1/companies/${companyId}`)
    .set(headersFor(platformAdmin))
    .send({ announcementAllowance: { postsPerMonth, peoplePerPost } })
    .expect(200);

const sponsoredBy = (companyId: string, title: string) => ({ ...CONSOLE, title, sponsorId: companyId });

/* ------------------------------------------------------------------ *
 * A. Choosing doctors by name
 * ------------------------------------------------------------------ */

describe('Choosing people by name', () => {
  const search = (actor: SignedIn, query: object) =>
    request(app).get('/api/v1/announcements/people').set(headersFor(actor)).query(query);

  test('finds clinic members by name, local phone or E.164, and nobody else', async () => {
    const { platformAdmin, contentManager, companyAdmin, doctor } = await theCast(10);
    const pa = await aPa(doctor, phone(10, 6));
    await Location.updateOne({ _id: doctor.locationId }, { $set: { city: 'Lahore', province: 'punjab' } });
    await User.updateOne({ _id: doctor.userId }, { $set: { specialties: ['cardiology'] } });

    // Called Imran too, but not active in a clinic: a patient's account, a
    // company's admin, the platform's own, and someone who left their clinic.
    await User.create({ phone: phone(10, 7), name: 'Imran the patient' });
    await User.updateOne({ _id: companyAdmin.userId }, { $set: { name: 'Imran of Acme' } });
    await User.updateOne({ _id: platformAdmin.userId }, { $set: { name: 'Imran at RxDictate' } });
    const { doctor: leaver } = await aClinic(phone(10, 8), 'Dr Imran Left');
    await Membership.updateMany({ userId: leaver.userId }, { $set: { status: 'removed', removedAt: new Date() } });

    const clinic = (await Practice.findById(doctor.practiceId))!;
    const byName = await search(contentManager, { q: 'imran' }).expect(200);
    expect(byName.body.data).toEqual([
      {
        id: doctor.userId,
        name: 'Dr Imran Qureshi',
        phone: doctor.phone,
        roles: ['doctor'],
        specialties: ['cardiology'],
        clinics: [{ id: doctor.practiceId, name: clinic.name }],
        cities: ['Lahore'],
      },
    ]);

    // A whole local number and its E.164 find the same person.
    const byLocal = await search(contentManager, { q: local(doctor.phone) }).expect(200);
    expect(byLocal.body.data.map((person: { id: string }) => person.id)).toEqual([doctor.userId]);
    const byE164 = await search(contentManager, { q: doctor.phone }).expect(200);
    expect(byE164.body.data.map((person: { id: string }) => person.id)).toEqual([doctor.userId]);
    // The start of a number finds everybody it begins, with an exact match first.
    const byStart = await search(contentManager, { q: local(doctor.phone).slice(0, 7) }).expect(200);
    const found = byStart.body.data.map((person: { id: string }) => person.id);
    expect(found.sort()).toEqual([doctor.userId, pa.userId].sort());

    // `role` keeps to people holding it in a clinic.
    expect((await search(contentManager, { q: 'sana', role: 'doctor' }).expect(200)).body.data).toEqual([]);
    expect((await search(contentManager, { q: 'sana', role: 'pa' }).expect(200)).body.data).toMatchObject([
      { id: pa.userId, roles: ['pa'] },
    ]);

    await search(contentManager, { q: 'i' }).expect(400);
    await search(companyAdmin, { q: 'imran' }).expect(403);
    await search(doctor, { q: 'imran' }).expect(403);
    const reviewer = await aPlatformMember(platformAdmin, phone(10, 9), 'reviewer');
    await search(reviewer, { q: 'imran' }).expect(403);
  });

  test('an announcement names the people it chooses, in order; one who left is still named, one deleted is not', async () => {
    const { contentManager, doctor } = await theCast(11);
    const pa = await aPa(doctor, phone(11, 6));
    const gone = await User.create({ phone: phone(11, 7), name: 'Soon gone' });

    const id = await draft(contentManager, {
      ...CONSOLE,
      audience: { userIds: [pa.userId, doctor.userId, String(gone._id)] },
    });
    await User.deleteOne({ _id: gone._id });
    await Membership.updateOne({ userId: pa.userId }, { $set: { status: 'removed', removedAt: new Date() } });

    const view = (await request(app).get(`/api/v1/announcements/${id}`).set(headersFor(contentManager)).expect(200)).body
      .data;
    expect(view.audience.userIds).toEqual([pa.userId, doctor.userId, String(gone._id)]);
    expect(view.people).toEqual([
      { id: pa.userId, name: 'Sana', phone: pa.phone, roles: [], specialties: [], clinics: [], cities: [] },
      expect.objectContaining({
        id: doctor.userId,
        roles: ['doctor'],
        clinics: [expect.objectContaining({ id: doctor.practiceId })],
      }),
    ]);
    expect(view).toMatchObject({ submissionId: null, forPerson: null });
  });

  test('an audience of chosen people alone reaches exactly them, and the count agrees', async () => {
    const { contentManager, doctor } = await theCast(12);
    const { doctor: other } = await aClinic(phone(12, 6), 'Dr Other');
    const pa = await aPa(doctor, phone(12, 7));

    const audience = { userIds: [doctor.userId, pa.userId] };
    await published(contentManager, { ...CONSOLE, title: 'Chosen', audience });

    expect(await titlesIn(doctor)).toEqual(['Chosen']);
    expect(await titlesIn(pa)).toEqual(['Chosen']);
    expect(await titlesIn(other)).toEqual([]);
    const count = await request(app)
      .post('/api/v1/announcements/audience-count')
      .set(headersFor(contentManager))
      .send({ audience })
      .expect(200);
    expect(count.body.data).toEqual({ users: 2 });
  });
});

/* ------------------------------------------------------------------ *
 * B. A company sends one for review
 * ------------------------------------------------------------------ */

describe('A company sends an announcement', () => {
  test('a valid one is pending; an editor may send it, a doctor may not', async () => {
    const { platformAdmin, companyEditor, company, doctor } = await theCast(20);

    const sent = await send(companyEditor, NEWS).expect(201);
    expect(sent.body.data).toMatchObject({
      type: 'announcement.create',
      status: 'pending',
      payload: { title: NEWS.title, kind: 'update', audience: { roles: [], specialties: [], provinces: [], cities: [] } },
      subject: null,
      drugId: null,
      resultAnnouncementId: null,
      organisation: { id: company.id, type: 'company' },
    });
    expect(await AuditLog.countDocuments({ action: 'submission.create' })).toBe(1);

    // The reviewer sees the company's allowance beside it; so does the company.
    const detail = await request(app)
      .get(`/api/v1/submissions/${sent.body.data.id}`)
      .set(headersFor(platformAdmin))
      .expect(200);
    expect(detail.body.data.allowance).toEqual({
      postsPerMonth: null,
      peoplePerPost: null,
      usedThisMonth: 0,
      month: karachiMonth(),
    });
    const own = await request(app)
      .get(`/api/v1/submissions/${sent.body.data.id}`)
      .set(headersFor(companyEditor))
      .expect(200);
    expect(own.body.data.allowance).toMatchObject({ usedThisMonth: 0 });

    await send(doctor, NEWS).expect(403);
    await send(platformAdmin, NEWS).expect(403);
  });

  test('a product is its own active medicine; clinics, people, slots or a sponsor are refused', async () => {
    const { platformAdmin, companyAdmin, company } = await theCast(21);
    const { company: rival } = await aCompany(platformAdmin, phone(21, 6), 'Rival Pharma');
    const ours = await aProduct(company.id, 'Zentra');
    const theirs = await aProduct(rival.id, 'Rivalin');

    const fieldOf = async (body: object): Promise<string> => {
      const response = await send(companyAdmin, body).expect(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      return JSON.stringify(response.body.error);
    };

    await send(companyAdmin, { ...NEWS, kind: 'product', drugId: String(ours._id), cta: 'learnMore' }).expect(201);
    expect(await fieldOf({ ...NEWS, kind: 'product', drugId: String(theirs._id) })).toContain('body.drugId');
    expect(await fieldOf({ ...NEWS, kind: 'product' })).toContain('drugId');
    expect(await fieldOf({ ...NEWS, audience: { organisationIds: [company.id] } })).toContain('organisationIds');
    expect(await fieldOf({ ...NEWS, audience: { userIds: [companyAdmin.userId] } })).toContain('userIds');
    expect(await fieldOf({ ...NEWS, placements: ['today.banner'] })).toContain('placements');
    expect(await fieldOf({ ...NEWS, sponsorId: company.id })).toContain('sponsorId');
    expect(await fieldOf({ ...NEWS, priority: 5 })).toContain('priority');
    // The console's rules hold too.
    expect(await fieldOf({ ...NEWS, cta: 'register' })).toContain('cta');
    await send(companyAdmin, { ...NEWS, audience: { roles: ['doctor'], cities: ['Lahore'] } }).expect(201);
  });

  test('a picture must be one the company uploaded itself; its audience count is by rule only', async () => {
    const { contentManager, companyAdmin } = await theCast(22);
    const upload = (actor: SignedIn) =>
      request(app)
        .post('/api/v1/announcements/images')
        .set(headersFor(actor))
        .send({ contentType: 'image/png', size: 2048 })
        .expect(201);

    const ours = (await upload(companyAdmin)).body.data.fileKey as string;
    const consoles = (await upload(contentManager)).body.data.fileKey as string;
    await send(companyAdmin, { ...NEWS, imageKey: ours }).expect(201);
    const refused = await send(companyAdmin, { ...NEWS, imageKey: consoles }).expect(400);
    expect(refused.body.error.details[0].field).toBe('body.imageKey');

    const count = (audience: object) =>
      request(app).post('/api/v1/announcements/audience-count').set(headersFor(companyAdmin)).send({ audience });
    expect((await count({ roles: ['doctor'] }).expect(200)).body.data).toEqual({ users: 1 });
    await count({ organisationIds: [new Types.ObjectId().toHexString()] }).expect(400);
    await count({ userIds: [companyAdmin.userId] }).expect(400);
  });
});

describe('Approving a company announcement', () => {
  test('makes a draft with the company as sponsor, linked both ways, and publishes nothing', async () => {
    const { platformAdmin, companyEditor, company, doctor } = await theCast(30);
    const product = await aProduct(company.id);
    const sent = await send(companyEditor, {
      ...NEWS,
      kind: 'product',
      drugId: String(product._id),
      cta: 'learnMore',
      audience: { roles: ['doctor'] },
    }).expect(201);

    const approved = await approve(platformAdmin, sent.body.data.id).expect(200);
    const announcementId = approved.body.data.resultAnnouncementId as string;
    expect(approved.body.data).toMatchObject({ status: 'approved', resultDrugId: null, subject: null });
    expect(announcementId).toEqual(expect.any(String));

    const view = (
      await request(app).get(`/api/v1/announcements/${announcementId}`).set(headersFor(platformAdmin)).expect(200)
    ).body.data;
    expect(view).toMatchObject({
      status: 'draft',
      title: NEWS.title,
      kind: 'product',
      drugId: String(product._id),
      sponsor: { id: company.id, name: 'Acme Pharma' },
      isSponsored: true,
      submissionId: sent.body.data.id,
      placements: ['inbox.updates'],
      priority: 0,
      maxShows: null,
      audience: { roles: ['doctor'], organisationIds: [], userIds: [] },
      createdBy: platformAdmin.userId,
      history: [{ step: 'created', by: platformAdmin.userId }],
    });
    expect(await titlesIn(doctor)).toEqual([]);

    // RxDictate publishes it in the console, and then the doctor sees it, labelled.
    await publish(platformAdmin, announcementId).expect(200);
    const slots = (
      await request(app)
        .get('/api/v1/announcements/slots')
        .query({ placement: 'inbox.updates' })
        .set(headersFor(doctor))
        .expect(200)
    ).body.data;
    expect(slots).toMatchObject([{ id: announcementId, isSponsored: true, sponsor: { id: company.id } }]);
  });

  test('a product discontinued while it waited is refused, and the submission stays pending', async () => {
    const { platformAdmin, companyAdmin, company } = await theCast(31);
    const product = await aProduct(company.id);
    const sent = await send(companyAdmin, { ...NEWS, kind: 'product', drugId: String(product._id) }).expect(201);
    await Drug.updateOne({ _id: product._id }, { $set: { status: 'discontinued' } });

    const refused = await approve(platformAdmin, sent.body.data.id).expect(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    expect((await Submission.findById(sent.body.data.id))!.status).toBe('pending');
    expect(await Announcement.countDocuments()).toBe(0);
  });

  test('reject, ask for changes, send again and withdraw work as for products', async () => {
    const { platformAdmin, companyAdmin, contentManager } = await theCast(32);
    const first = (await send(companyAdmin, NEWS).expect(201)).body.data.id;
    await request(app)
      .post(`/api/v1/submissions/${first}/reject`)
      .set(headersFor(platformAdmin))
      .send({ note: 'Not for doctors' })
      .expect(200);

    const second = (await send(companyAdmin, NEWS).expect(201)).body.data.id;
    await request(app)
      .post(`/api/v1/submissions/${second}/request-changes`)
      .set(headersFor(platformAdmin))
      .send({ note: 'Shorter title, please' })
      .expect(200);
    // Sent again, checked as if fresh: another organisation's picture is refused where it sits.
    const consoles = (
      await request(app)
        .post('/api/v1/announcements/images')
        .set(headersFor(contentManager))
        .send({ contentType: 'image/jpeg', size: 100 })
        .expect(201)
    ).body.data.fileKey;
    const wrong = await request(app)
      .patch(`/api/v1/submissions/${second}`)
      .set(headersFor(companyAdmin))
      .send({ payload: { ...NEWS, imageKey: consoles } })
      .expect(400);
    expect(wrong.body.error.details[0].field).toBe('body.payload.imageKey');
    const again = await request(app)
      .patch(`/api/v1/submissions/${second}`)
      .set(headersFor(companyAdmin))
      .send({ payload: { ...NEWS, title: 'Packs of 30' } })
      .expect(200);
    expect(again.body.data).toMatchObject({ status: 'pending', payload: { title: 'Packs of 30' } });

    await request(app).post(`/api/v1/submissions/${second}/withdraw`).set(headersFor(companyAdmin)).expect(200);
    await approve(platformAdmin, second).expect(409);
    expect(await Announcement.countDocuments()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * C. A company's allowance
 * ------------------------------------------------------------------ */

describe("A company's allowance", () => {
  test('there is none by default; RxDictate sets one, audited, and the company reads it', async () => {
    const { platformAdmin, companyAdmin, company } = await theCast(40);
    const month = karachiMonth();

    const before = await request(app).get(`/api/v1/companies/${company.id}`).set(headersFor(platformAdmin)).expect(200);
    expect(before.body.data.announcementAllowance).toEqual({
      postsPerMonth: null,
      peoplePerPost: null,
      usedThisMonth: 0,
      month,
    });

    await setAllowance(platformAdmin, company.id, 2, 500);
    expect(await AuditLog.countDocuments({ action: 'company.update', entityId: company.id })).toBe(1);
    const own = await request(app).get('/api/v1/company').set(headersFor(companyAdmin)).expect(200);
    expect(own.body.data.announcementAllowance).toEqual({ postsPerMonth: 2, peoplePerPost: 500, usedThisMonth: 0, month });

    await request(app)
      .patch(`/api/v1/companies/${company.id}`)
      .set(headersFor(platformAdmin))
      .send({ announcementAllowance: { postsPerMonth: 0, peoplePerPost: null } })
      .expect(400);
    await request(app)
      .patch(`/api/v1/companies/${company.id}`)
      .set(headersFor(platformAdmin))
      .send({ announcementAllowance: { postsPerMonth: 3 } })
      .expect(400);
  });

  test("past the month's posts is refused; a withdrawn one still counts, a draft does not; next month is fresh", async () => {
    const { platformAdmin, contentManager, company } = await theCast(41);
    await setAllowance(platformAdmin, company.id, 2, null);

    const first = await published(contentManager, sponsoredBy(company.id, 'First'));
    await request(app).post(`/api/v1/announcements/${first}/withdraw`).set(headersFor(contentManager)).expect(200);
    await published(contentManager, sponsoredBy(company.id, 'Second'));
    // Drafts and RxDictate's own do not count.
    const third = await draft(contentManager, { ...sponsoredBy(company.id, 'Third'), showUntil: at(60 * DAY) });
    await published(contentManager, { ...CONSOLE, title: 'Ours' });

    const refused = await publish(contentManager, third).expect(409);
    expect(refused.body.error).toMatchObject({
      code: 'ANNOUNCEMENT_ALLOWANCE_USED',
      details: { used: 2, allowed: 2, month: karachiMonth() },
    });
    const view = await request(app).get(`/api/v1/companies/${company.id}`).set(headersFor(platformAdmin)).expect(200);
    expect(view.body.data.announcementAllowance.usedThisMonth).toBe(2);

    // A day into next month, it may go.
    const nextMonth = new Date(karachiMonthRange(karachiMonth()).end.getTime() + DAY);
    const scope = {
      practiceId: new Types.ObjectId(platformAdmin.practiceId),
      actorId: new Types.ObjectId(platformAdmin.userId),
      role: 'platformAdmin' as const,
      allowedLocationIds: 'all' as const,
    };
    const next = await publishAnnouncement(scope, third, nextMonth);
    expect(next.status).toBe('published');
  });

  test('an audience reaching more people than one post may is refused, at publishing and when widened', async () => {
    const { platformAdmin, contentManager, company, doctor } = await theCast(42);
    await aClinic(phone(42, 6), 'Dr Second');
    await setAllowance(platformAdmin, company.id, null, 1);

    const wide = await draft(contentManager, sponsoredBy(company.id, 'Everyone'));
    const refused = await publish(contentManager, wide).expect(409);
    expect(refused.body.error).toMatchObject({
      code: 'ANNOUNCEMENT_REACH_OVER_ALLOWANCE',
      details: { reach: 2, allowed: 1 },
    });

    const narrow = await published(contentManager, {
      ...sponsoredBy(company.id, 'One'),
      audience: { userIds: [doctor.userId] },
    });
    const widened = await request(app)
      .patch(`/api/v1/announcements/${narrow}`)
      .set(headersFor(contentManager))
      .send({ audience: { roles: ['doctor'] } })
      .expect(409);
    expect(widened.body.error.code).toBe('ANNOUNCEMENT_REACH_OVER_ALLOWANCE');
    expect((await Announcement.findById(narrow))!.audience.userIds.map(String)).toEqual([doctor.userId]);
  });

  test("moving a published one to another sponsor checks that sponsor's posts, and frees the first's", async () => {
    const { platformAdmin, contentManager, company } = await theCast(43);
    const { company: other } = await aCompany(platformAdmin, phone(43, 6), 'Other Pharma');
    await setAllowance(platformAdmin, other.id, 1, null);
    await published(contentManager, sponsoredBy(other.id, 'Other’s only post'));

    const ours = await published(contentManager, sponsoredBy(company.id, 'Ours'));
    const moved = await request(app)
      .patch(`/api/v1/announcements/${ours}`)
      .set(headersFor(contentManager))
      .send({ sponsorId: other.id })
      .expect(409);
    expect(moved.body.error.code).toBe('ANNOUNCEMENT_ALLOWANCE_USED');

    await request(app)
      .patch(`/api/v1/announcements/${ours}`)
      .set(headersFor(contentManager))
      .send({ sponsorId: null })
      .expect(200);
    const view = await request(app).get(`/api/v1/companies/${company.id}`).set(headersFor(platformAdmin)).expect(200);
    expect(view.body.data.announcementAllowance.usedThisMonth).toBe(0);
  });

  test('two publishes at once cannot both have the last post', async () => {
    const { platformAdmin, contentManager, company } = await theCast(44);
    await setAllowance(platformAdmin, company.id, 1, null);
    const ids = await Promise.all(
      ['One', 'Two', 'Three'].map((title) => draft(contentManager, sponsoredBy(company.id, title))),
    );

    const statuses = (await Promise.all(ids.map((id) => publish(contentManager, id)))).map((response) => response.status);
    expect(statuses.sort()).toEqual([200, 409, 409]);
    expect(await Announcement.countDocuments({ status: 'published' })).toBe(1);
  });

  test("a company's submission is accepted whatever its allowance", async () => {
    const { platformAdmin, contentManager, companyAdmin, company } = await theCast(45);
    await setAllowance(platformAdmin, company.id, 1, null);
    await published(contentManager, sponsoredBy(company.id, 'Used it'));

    const sent = (await send(companyAdmin, NEWS).expect(201)).body.data.id;
    const approved = await approve(platformAdmin, sent).expect(200);
    const refused = await publish(platformAdmin, approved.body.data.resultAnnouncementId).expect(409);
    expect(refused.body.error.code).toBe('ANNOUNCEMENT_ALLOWANCE_USED');
  });
});

/* ------------------------------------------------------------------ *
 * D. Who saw what
 * ------------------------------------------------------------------ */

describe('Who saw what', () => {
  test('a person’s shows, clicks and when they were first and last shown are kept', async () => {
    const { contentManager, doctor } = await theCast(50);
    const id = await published(contentManager, CONSOLE);

    await event(doctor, id, 'shown');
    const first = (await AnnouncementState.findOne({ userId: doctor.userId }))!;
    await event(doctor, id, 'shown');
    await event(doctor, id, 'clicked');

    const state = (await AnnouncementState.findOne({ userId: doctor.userId }))!;
    expect(state).toMatchObject({ shows: 2, clicks: 1 });
    expect(state.firstShownAt).toEqual(first.firstShownAt);
    expect(state.lastShownAt!.getTime()).toBeGreaterThanOrEqual(first.lastShownAt!.getTime());
    expect((await Announcement.findById(id))!.stats).toMatchObject({ shows: 2, clicks: 1 });
  });

  test("one person's list: what they are in the audience of now, and what they were shown before", async () => {
    const { platformAdmin, contentManager, company, doctor } = await theCast(51);
    const { doctor: other } = await aClinic(phone(51, 6), 'Dr Other');

    const shown = await published(contentManager, sponsoredBy(company.id, 'Shown'));
    const unseen = await published(contentManager, { ...CONSOLE, title: 'Not yet seen' });
    await published(contentManager, { ...CONSOLE, title: 'Someone else', audience: { userIds: [other.userId] } });
    const gone = await published(contentManager, { ...CONSOLE, title: 'Withdrawn' });
    await draft(contentManager, { ...CONSOLE, title: 'A draft' });

    await event(doctor, shown, 'shown');
    await event(doctor, shown, 'shown');
    await event(doctor, shown, 'clicked');
    await event(doctor, gone, 'shown');
    await event(doctor, gone, 'dismissed');
    await request(app).post(`/api/v1/announcements/${gone}/withdraw`).set(headersFor(contentManager)).expect(200);

    const list = (query: object) => request(app).get('/api/v1/announcements').set(headersFor(platformAdmin)).query(query);
    const response = await list({ userId: doctor.userId }).expect(200);
    const rows = response.body.data as { id: string; title: string; forPerson: Record<string, unknown> }[];
    expect(rows.map((row) => row.title)).toEqual(['Withdrawn', 'Not yet seen', 'Shown']);
    expect(response.body.meta).toMatchObject({ total: 3 });
    expect(rows.find((row) => row.id === shown)!.forPerson).toMatchObject({
      inAudience: true,
      shows: 2,
      clicks: 1,
      dismissed: false,
      reminded: false,
      registered: false,
      firstShownAt: expect.any(String),
      lastShownAt: expect.any(String),
    });
    expect(rows.find((row) => row.id === unseen)!.forPerson).toMatchObject({
      inAudience: true,
      shows: 0,
      firstShownAt: null,
    });
    expect(rows.find((row) => row.id === gone)!.forPerson).toMatchObject({ shows: 1, dismissed: true });

    // It combines with the other filters.
    const withdrawn = await list({ userId: doctor.userId, status: 'withdrawn' }).expect(200);
    expect(withdrawn.body.data.map((row: { id: string }) => row.id)).toEqual([gone]);
    const theirs = await list({ userId: doctor.userId, sponsorId: company.id }).expect(200);
    expect(theirs.body.data.map((row: { id: string }) => row.id)).toEqual([shown]);
    // Without userId, nobody's record.
    const plain = await list({}).expect(200);
    expect(plain.body.data.every((row: { forPerson: unknown }) => row.forPerson === null)).toBe(true);

    const audits = await AuditLog.find({ action: 'announcement.people.read' });
    expect(audits).toHaveLength(3);
    expect(String(audits[0].entityId)).toBe(doctor.userId);
    expect(audits[0].after).toMatchObject({ query: { userId: doctor.userId } });
  });

  test('reach: one row per person shown any of a sponsor’s, or one announcement, most shows first', async () => {
    const { platformAdmin, contentManager, company, doctor } = await theCast(52);
    const { doctor: second } = await aClinic(phone(52, 6), 'Dr Second');

    const a = await published(contentManager, sponsoredBy(company.id, 'A'));
    const b = await published(contentManager, sponsoredBy(company.id, 'B'));
    const ours = await published(contentManager, { ...CONSOLE, title: 'Ours' });
    await event(doctor, a, 'shown');
    await event(doctor, a, 'shown');
    await event(doctor, a, 'clicked');
    await event(doctor, b, 'shown');
    await event(doctor, ours, 'shown');
    await event(second, a, 'shown');
    await event(second, a, 'dismissed');

    const reach = (query: object) =>
      request(app).get('/api/v1/announcements/reach').set(headersFor(platformAdmin)).query(query);
    const bySponsor = await reach({ sponsorId: company.id }).expect(200);
    expect(bySponsor.body.data).toEqual([
      {
        person: expect.objectContaining({ id: doctor.userId, name: 'Dr Imran Qureshi' }),
        announcements: 2,
        shows: 3,
        clicks: 1,
        dismissed: 0,
        lastShownAt: expect.any(String),
      },
      {
        person: expect.objectContaining({ id: second.userId }),
        announcements: 1,
        shows: 1,
        clicks: 0,
        dismissed: 1,
        lastShownAt: expect.any(String),
      },
    ]);
    expect(bySponsor.body.meta).toMatchObject({ total: 2 });

    const byOne = await reach({ announcementId: b }).expect(200);
    expect(byOne.body.data.map((row: { person: { id: string } }) => row.person.id)).toEqual([doctor.userId]);
    const rxDictates = await reach({ sponsorId: 'none' }).expect(200);
    expect(rxDictates.body.data).toMatchObject([{ person: { id: doctor.userId }, announcements: 1, shows: 1 }]);
    const paged = await reach({ sponsorId: company.id, limit: 1, page: 2 }).expect(200);
    expect(paged.body.data.map((row: { person: { id: string } }) => row.person.id)).toEqual([second.userId]);

    await reach({}).expect(400);
    await reach({ sponsorId: company.id, announcementId: a }).expect(400);
    expect(await AuditLog.countDocuments({ action: 'announcement.people.read' })).toBe(4);
  });

  test("only RxDictate's admin may: not a content manager, a reviewer or a company", async () => {
    const { platformAdmin, contentManager, companyAdmin, company, doctor } = await theCast(53);
    const reviewer = await aPlatformMember(platformAdmin, phone(53, 6), 'reviewer');

    await Promise.all(
      [contentManager, reviewer, companyAdmin].flatMap((actor) => [
        request(app).get('/api/v1/announcements').set(headersFor(actor)).query({ userId: doctor.userId }).expect(403),
        request(app).get('/api/v1/announcements/reach').set(headersFor(actor)).query({ sponsorId: company.id }).expect(403),
      ]),
    );
    // The content manager still lists announcements without userId.
    await request(app).get('/api/v1/announcements').set(headersFor(contentManager)).expect(200);
    expect(await AuditLog.countDocuments({ action: 'announcement.people.read' })).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * What the company sees
 * ------------------------------------------------------------------ */

describe("The company's own list", () => {
  test('every one it sponsors, whoever wrote it, with totals only; never another company’s', async () => {
    const { platformAdmin, contentManager, companyAdmin, company, doctor } = await theCast(60);
    const { company: rival } = await aCompany(platformAdmin, phone(60, 6), 'Rival Pharma');

    const sent = (await send(companyAdmin, NEWS).expect(201)).body.data.id;
    const fromReview = (await approve(platformAdmin, sent).expect(200)).body.data.resultAnnouncementId;
    const written = await published(contentManager, sponsoredBy(company.id, 'Written for them'));
    await published(contentManager, sponsoredBy(rival.id, 'Rival'));
    await published(contentManager, { ...CONSOLE, title: 'Ours' });
    await event(doctor, written, 'shown');
    await event(doctor, written, 'clicked');

    const response = await request(app).get('/api/v1/company/announcements').set(headersFor(companyAdmin)).expect(200);
    const rows = response.body.data as Record<string, unknown>[];
    expect(rows.map((row) => row.id)).toEqual([written, fromReview]);
    rows.forEach((row) => expect(Object.keys(row).sort()).toEqual(Object.keys(companyAnnouncementViewSchema.shape).sort()));
    expect(rows[0]).toMatchObject({
      status: 'published',
      submissionId: null,
      stats: { shows: 1, clicks: 1, dismissals: 0, reminders: 0, registrations: 0 },
    });
    expect(rows[1]).toMatchObject({ status: 'draft', submissionId: sent, publishedAt: null });

    await request(app).get('/api/v1/company/announcements').set(headersFor(doctor)).expect(403);
  });

  test('who registered, for its own seminars and events only', async () => {
    const { platformAdmin, contentManager, companyEditor, company, doctor } = await theCast(61);
    const { company: rival } = await aCompany(platformAdmin, phone(61, 6), 'Rival Pharma');
    const seminar = (sponsorId: string, title: string) => ({
      ...sponsoredBy(sponsorId, title),
      kind: 'seminar',
      cta: 'register',
      event: { startsAt: at(3 * DAY), place: 'Pearl Continental, Lahore' },
      showUntil: at(3 * DAY),
    });
    const ours = await published(contentManager, seminar(company.id, 'Our seminar'));
    const theirs = await published(contentManager, seminar(rival.id, 'Their seminar'));
    await request(app)
      .post(`/api/v1/announcements/${ours}/register`)
      .set(headersFor(doctor))
      .send({ consent: true })
      .expect(200);

    const list = await request(app)
      .get(`/api/v1/company/announcements/${ours}/registrations`)
      .set(headersFor(companyEditor))
      .expect(200);
    expect(list.body.data).toMatchObject([{ userId: doctor.userId, name: 'Dr Imran Qureshi', phone: doctor.phone }]);
    const csv = await request(app)
      .get(`/api/v1/company/announcements/${ours}/registrations.csv`)
      .set(headersFor(companyEditor))
      .expect(200);
    expect(csv.text).toContain('Dr Imran Qureshi');

    await request(app)
      .get(`/api/v1/company/announcements/${theirs}/registrations`)
      .set(headersFor(companyEditor))
      .expect(404);
    await request(app)
      .get(`/api/v1/company/announcements/${theirs}/registrations.csv`)
      .set(headersFor(companyEditor))
      .expect(404);
  });
});

/* ------------------------------------------------------------------ *
 * Slots and live updates
 * ------------------------------------------------------------------ */

describe('In the slots', () => {
  test("a company's approved and published one is labelled sponsored, and hidden when sponsored is off", async () => {
    const { platformAdmin, companyAdmin, company, doctor } = await theCast(70);
    const sent = (await send(companyAdmin, { ...NEWS, title: 'From Acme' }).expect(201)).body.data.id;
    const id = (await approve(platformAdmin, sent).expect(200)).body.data.resultAnnouncementId;
    await publish(platformAdmin, id).expect(200);
    await published(platformAdmin, { ...CONSOLE, title: 'Ours' });

    const slots = (
      await request(app)
        .get('/api/v1/announcements/slots')
        .query({ placement: 'inbox.updates' })
        .set(headersFor(doctor))
        .expect(200)
    ).body.data;
    expect(slots.find((slot: { id: string }) => slot.id === id)).toMatchObject({
      isSponsored: true,
      sponsor: { id: company.id, name: 'Acme Pharma' },
    });

    await request(app)
      .patch('/api/v1/settings/me')
      .set(headersFor(doctor))
      .send({ values: [{ key: 'announcements.sponsored', value: false }] })
      .expect(200);
    expect(await titlesIn(doctor)).toEqual(['Ours']);
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

  test('a company hears `announcements` about its own, from the draft approval on, and never about another’s', async () => {
    const { platformAdmin, contentManager, companyAdmin, company, doctor } = await theCast(80);
    const { company: rival, companyAdmin: rivalAdmin } = await aCompany(platformAdmin, phone(80, 6), 'Rival Pharma');
    const ours = await signedIn(live.url, companyAdmin);
    const theirs = await signedIn(live.url, rivalAdmin);
    const clinic = await signedIn(live.url, doctor, doctor.locationId);
    opened.push(ours, theirs, clinic);
    const about = (client: LiveClient, id: string) =>
      client.changes('announcements').filter((message) => message.id === id).length;

    // Approving tells the company its submission moved, and that the draft exists; clinics hear nothing of a draft.
    const sent = (await send(companyAdmin, NEWS).expect(201)).body.data.id;
    const id = (await approve(platformAdmin, sent).expect(200)).body.data.resultAnnouncementId;
    await ours.until(() => about(ours, id) === 1 && ours.changes('submissions').some((message) => message.id === sent));

    await publish(platformAdmin, id).expect(200);
    await ours.until(() => about(ours, id) === 2);
    await clinic.until(() => about(clinic, id) === 1);
    await request(app).post(`/api/v1/announcements/${id}/withdraw`).set(headersFor(platformAdmin)).expect(200);
    await ours.until(() => about(ours, id) === 3);

    const rivals = await published(contentManager, sponsoredBy(rival.id, 'Rival'));
    await theirs.until(() => about(theirs, rivals) === 1);
    await clinic.until(() => about(clinic, rivals) === 1);
    expect(about(ours, rivals)).toBe(0);
    expect(about(theirs, id)).toBe(0);
    expect(company.id).not.toBe(rival.id);
  });
});

/* ------------------------------------------------------------------ *
 * The medicine and image a submission names
 * ------------------------------------------------------------------ */

describe("A company announcement's medicine and image in the review queue", () => {
  const detailOf = async (actor: SignedIn, id: string) =>
    (await request(app).get(`/api/v1/submissions/${id}`).set(headersFor(actor)).expect(200)).body.data;

  test('the reviewer and the sender both see the product by name and the image by a signed link', async () => {
    const { platformAdmin, companyEditor, company } = await theCast(90);
    const product = await aProduct(company.id, 'Zentra');
    const imageKey = (
      await request(app)
        .post('/api/v1/announcements/images')
        .set(headersFor(companyEditor))
        .send({ contentType: 'image/png', size: 2048 })
        .expect(201)
    ).body.data.fileKey;
    const sent = (await send(companyEditor, { ...NEWS, kind: 'product', drugId: String(product._id), imageKey }).expect(201))
      .body.data.id;

    const expected = {
      product: { id: String(product._id), brand: 'Zentra', strength: '250mg' },
      image: { url: expect.any(String), expiresAt: expect.any(String) },
    };
    expect((await detailOf(platformAdmin, sent)).announcement).toEqual(expected);
    expect((await detailOf(companyEditor, sent)).announcement).toEqual(expected);
  });

  test('an update with no image has neither', async () => {
    const { platformAdmin, companyAdmin } = await theCast(91);
    const sent = (await send(companyAdmin, NEWS).expect(201)).body.data.id;
    expect((await detailOf(platformAdmin, sent)).announcement).toEqual({ product: null, image: null });
  });

  test('a medicine discontinued while it waits still comes back by name', async () => {
    const { platformAdmin, companyAdmin, company } = await theCast(92);
    const product = await aProduct(company.id, 'Zentra');
    const sent = (await send(companyAdmin, { ...NEWS, kind: 'product', drugId: String(product._id) }).expect(201)).body.data
      .id;
    await Drug.updateOne({ _id: product._id }, { $set: { status: 'discontinued' } });

    expect((await detailOf(platformAdmin, sent)).announcement).toEqual({
      product: { id: String(product._id), brand: 'Zentra', strength: '250mg' },
      image: null,
    });
  });

  test('every other type has none', async () => {
    const { platformAdmin, companyAdmin, company } = await theCast(93);
    const product = await aProduct(company.id, 'Zentra');
    const created = await request(app)
      .post('/api/v1/company/products')
      .set(headersFor(companyAdmin))
      .send({ brand: 'Novel', strength: '10mg', registrationNo: 'R-NEW-1' })
      .expect(201);
    const updated = await request(app)
      .patch(`/api/v1/company/products/${String(product._id)}`)
      .set(headersFor(companyAdmin))
      .send({ pack: '3x10' })
      .expect(201);

    [created, updated].forEach((response) => expect(response.body.data.announcement).toBeNull());
    expect((await detailOf(platformAdmin, created.body.data.submission.id)).announcement).toBeNull();
    expect((await detailOf(platformAdmin, updated.body.data.submission.id)).announcement).toBeNull();
  });
});
