import request from 'supertest';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aDraft, aPlatformAdmin, headersFor, signIn, type SignedIn } from '../fixtures/clinic.fixture';
import { signedIn, startLive, type Live, type LiveClient } from '../fixtures/realtime.fixture';
import { AuditLog, Drug, DrugList, DrugUsage, Membership, Practice, Prescription, Submission } from '../../src/models';
import { provider } from '../../src/core/sms';
import { importDrugs } from '../../src/services/drugImport.service';
import { COMPANY_CSV_MAX_ROWS } from '../../src/shared/company.schema';

setupTestDB();
jest.setTimeout(60_000);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const HEADER = 'registrationNo,brand,composition,strength,form,pack,company';

/** National rows from a DRAP file: `R1,Panadol,Paracetamol,500mg,Tablet,10x10,GSK`. */
const catalog = async (...rows: string[]) => importDrugs([HEADER, ...rows].join('\n'));

const drapRow = async (registrationNo: string) => (await Drug.findOne({ drapRegNo: registrationNo }))!;

/** A company made by a platform admin, and its first admin signed in. */
const aCompany = async (platformAdmin: SignedIn, adminPhone: string, name = 'Acme Pharma') => {
  const created = await request(app)
    .post('/api/v1/companies')
    .set(headersFor(platformAdmin))
    .send({
      name,
      secpRegNo: `SECP-${adminPhone}`,
      drapLicenceNo: `DL-${adminPhone}`,
      city: 'lahore',
      province: 'punjab',
      contactPhone: adminPhone,
      admin: { phone: adminPhone, name: 'Company Admin' },
    })
    .expect(201);
  return { company: created.body.data as { id: string; name: string }, companyAdmin: await signIn(adminPhone) };
};

/** Somebody added by phone with a role, then signed in. Their only membership is this one. */
const aStaffMember = async (by: SignedIn, phone: string, role: string): Promise<SignedIn> => {
  await request(app).post('/api/v1/members').set(headersFor(by)).send({ phone, role }).expect(201);
  return signIn(phone);
};

const PRODUCT = {
  brand: 'Zentra',
  composition: 'Zentramol 250mg',
  strength: '250mg',
  form: 'tab',
  pack: '10x10',
  registrationNo: 'C-0001',
};

const sendProduct = (actor: SignedIn, body: object = PRODUCT) =>
  request(app).post('/api/v1/company/products').set(headersFor(actor)).send(body);

const decide = (reviewer: SignedIn, id: string, action: 'approve' | 'reject' | 'request-changes', body: object = {}) =>
  request(app).post(`/api/v1/submissions/${id}/${action}`).set(headersFor(reviewer)).send(body);

const searchAs = async (doctor: SignedIn, q: string): Promise<string[]> =>
  (
    await request(app).get('/api/v1/drugs').query({ q, everywhere: 'true' }).set(headersFor(doctor)).expect(200)
  ).body.data.map((drug: { brand: string }) => drug.brand);

/** Prescribe these drugs and sign, which is what counts usage. */
const prescribe = async (
  doctor: SignedIn,
  patientId: string,
  ...drugs: { id: string; brand: string; strength: string; form: string }[]
) => {
  const draft = await aDraft(doctor, patientId);
  await request(app)
    .patch(`/api/v1/prescriptions/${draft.id}`)
    .set(headersFor(doctor, { location: true }))
    .send({
      ops: drugs.map((drug) => ({
        op: 'add',
        section: 'medicines',
        value: { name: drug.brand, strength: drug.strength, form: drug.form, drugId: drug.id },
      })),
    })
    .expect(200);
  await request(app)
    .post(`/api/v1/prescriptions/${draft.id}/approve`)
    .set(headersFor(doctor, { location: true }))
    .expect(200);
  return draft.id as string;
};

/** Everyone a review needs: RxDictate's admin and a reviewer, one company, one clinic. */
const theCast = async (base: number) => {
  const platformAdmin = await aPlatformAdmin(`+9230077${base}01`);
  const reviewer = await aStaffMember(platformAdmin, `+9230077${base}02`, 'reviewer');
  const { company, companyAdmin } = await aCompany(platformAdmin, `+9230077${base}03`);
  const { doctor, patientId } = await aClinic(`+9230077${base}04`);
  return { platformAdmin, reviewer, company, companyAdmin, doctor, patientId };
};

/* ------------------------------------------------------------------ *
 * Companies
 * ------------------------------------------------------------------ */

describe('Companies', () => {
  test('a platform admin makes a company with its first admin, who is told by SMS and signs in to it', async () => {
    const sms = jest.spyOn(provider(), 'send');
    const platformAdmin = await aPlatformAdmin('+923007700101');
    const { company, companyAdmin } = await aCompany(platformAdmin, '+923007700102', 'Zenith Labs');

    expect(company).toMatchObject({
      name: 'Zenith Labs',
      city: 'Lahore',
      province: 'punjab',
      secpRegNo: 'SECP-+923007700102',
      status: 'active',
    });
    const stored = await Practice.findById(company.id);
    expect(stored?.type).toBe('company');
    expect(String(stored?.ownerId)).toBe(companyAdmin.userId);

    const membership = await Membership.findOne({ practiceId: company.id, userId: companyAdmin.userId });
    expect(membership?.role).toBe('companyAdmin');
    expect(companyAdmin.practiceId).toBe(company.id);

    const added = sms.mock.calls.filter(([, body]) => body.includes('You have been added'));
    expect(added).toEqual([['+923007700102', expect.stringContaining('You have been added to Zenith Labs')]]);
    expect(added[0][1]).not.toMatch(/Dr\./);

    const me = (
      await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${companyAdmin.accessToken}` })
        .expect(200)
    ).body.data;
    expect(me.memberships[0]).toMatchObject({
      organisationType: 'company',
      organisationStatus: 'active',
      role: 'companyAdmin',
    });

    const own = await request(app).get('/api/v1/company').set(headersFor(companyAdmin)).expect(200);
    expect(own.body.data).toMatchObject({ id: company.id, name: 'Zenith Labs' });

    expect(await AuditLog.countDocuments({ action: 'company.create', entityId: company.id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'member.add', practiceId: company.id })).toBe(1);
    sms.mockRestore();
  });

  test('companies are paged and searchable, read and edited by the platform, and an SECP number is one company', async () => {
    const platformAdmin = await aPlatformAdmin('+923007700111');
    const { company } = await aCompany(platformAdmin, '+923007700112', 'Alpha Pharma');
    await aCompany(platformAdmin, '+923007700113', 'Beta Labs');

    const found = await request(app)
      .get('/api/v1/companies')
      .query({ q: 'alph' })
      .set(headersFor(platformAdmin))
      .expect(200);
    expect(found.body.data.map((row: { name: string }) => row.name)).toEqual(['Alpha Pharma']);
    expect(found.body.meta).toMatchObject({ page: 1, total: 1 });

    const all = await request(app).get('/api/v1/companies').query({ limit: 1 }).set(headersFor(platformAdmin)).expect(200);
    expect(all.body.meta).toMatchObject({ total: 2, totalPages: 2 });

    await request(app).get(`/api/v1/companies/${company.id}`).set(headersFor(platformAdmin)).expect(200);
    const edited = await request(app)
      .patch(`/api/v1/companies/${company.id}`)
      .set(headersFor(platformAdmin))
      .send({ name: 'Alpha Pharmaceuticals' })
      .expect(200);
    expect(edited.body.data.name).toBe('Alpha Pharmaceuticals');

    const twice = await request(app)
      .post('/api/v1/companies')
      .set(headersFor(platformAdmin))
      .send({ name: 'Copy', secpRegNo: 'SECP-+923007700112', drapLicenceNo: 'X', admin: { phone: '+923007700114' } })
      .expect(409);
    expect(twice.body.error.code).toBe('CONFLICT');
  });

  test('a reviewer reads companies but cannot make, edit or suspend one', async () => {
    const platformAdmin = await aPlatformAdmin('+923007700121');
    const reviewer = await aStaffMember(platformAdmin, '+923007700122', 'reviewer');
    const { company } = await aCompany(platformAdmin, '+923007700123');

    await request(app).get('/api/v1/companies').set(headersFor(reviewer)).expect(200);
    const refused = await Promise.all([
      request(app)
        .post('/api/v1/companies')
        .set(headersFor(reviewer))
        .send({ name: 'Nope', secpRegNo: 'S', drapLicenceNo: 'D', admin: { phone: '+923007700124' } }),
      request(app).patch(`/api/v1/companies/${company.id}`).set(headersFor(reviewer)).send({ name: 'Nope' }),
      request(app).post(`/api/v1/companies/${company.id}/suspend`).set(headersFor(reviewer)),
    ]);
    refused.forEach((response) => expect(response.body.error?.code).toBe('FORBIDDEN'));
    expect(await Practice.countDocuments({ type: 'company' })).toBe(1);
  });

  test("a suspended company's members are refused everywhere; its pending work waits and its live products stay", async () => {
    const { platformAdmin, reviewer, company, companyAdmin, doctor } = await theCast(13);
    const live = (await sendProduct(companyAdmin).expect(201)).body.data.submission.id;
    await decide(reviewer, live, 'approve').expect(200);
    const waiting = (await sendProduct(companyAdmin, { ...PRODUCT, brand: 'Waitol', registrationNo: 'C-0002' }).expect(201))
      .body.data.submission.id;

    const suspended = await request(app)
      .post(`/api/v1/companies/${company.id}/suspend`)
      .set(headersFor(platformAdmin))
      .expect(200);
    expect(suspended.body.data).toMatchObject({ status: 'suspended' });

    const routes = [
      request(app).get('/api/v1/company').set(headersFor(companyAdmin)),
      request(app).get('/api/v1/company/products').set(headersFor(companyAdmin)),
      sendProduct(companyAdmin, { ...PRODUCT, registrationNo: 'C-0003' }),
      request(app).get('/api/v1/submissions').set(headersFor(companyAdmin)),
      request(app).get('/api/v1/members').set(headersFor(companyAdmin)),
      request(app).get('/api/v1/settings').set(headersFor(companyAdmin)),
    ];
    (await Promise.all(routes)).forEach((response) => {
      expect({ status: response.status, code: response.body.error?.code }).toEqual({
        status: 403,
        code: 'ORGANISATION_SUSPENDED',
      });
    });

    const me = (
      await request(app)
        .get('/api/v1/me')
        .set({ Authorization: `Bearer ${companyAdmin.accessToken}` })
    ).body.data;
    expect(me.memberships[0].organisationStatus).toBe('suspended');

    // Pending work waits: not decided, not touched.
    expect((await decide(reviewer, waiting, 'approve').expect(403)).body.error.code).toBe('ORGANISATION_SUSPENDED');
    expect((await Submission.findById(waiting))?.status).toBe('pending');
    // Live products stay, because doctors rely on them.
    expect(await searchAs(doctor, 'zentra')).toContain('Zentra');

    await request(app).post(`/api/v1/companies/${company.id}/reactivate`).set(headersFor(platformAdmin)).expect(200);
    await request(app).get('/api/v1/company').set(headersFor(companyAdmin)).expect(200);
    await decide(reviewer, waiting, 'approve').expect(200);
  });
});

/* ------------------------------------------------------------------ *
 * Isolation
 * ------------------------------------------------------------------ */

describe('Isolation', () => {
  test("a company cannot read or touch another company's products, submissions or staff", async () => {
    const { platformAdmin, reviewer, companyAdmin } = await theCast(21);
    const { companyAdmin: other } = await aCompany(platformAdmin, '+923007721099', 'Other Pharma');

    const sent = (await sendProduct(other, { ...PRODUCT, brand: 'Othermol', registrationNo: 'O-1' }).expect(201)).body.data
      .submission.id;
    await decide(reviewer, sent, 'approve').expect(200);
    const theirProduct = String((await drapRow('O-1'))._id);
    const theirStaff = await Membership.findOne({ userId: other.userId });

    expect((await request(app).get('/api/v1/company/products').set(headersFor(companyAdmin)).expect(200)).body.data).toEqual(
      [],
    );
    expect((await request(app).get('/api/v1/submissions').set(headersFor(companyAdmin)).expect(200)).body.data).toEqual([]);

    const refused = await Promise.all([
      request(app).get(`/api/v1/submissions/${sent}`).set(headersFor(companyAdmin)),
      request(app).patch(`/api/v1/company/products/${theirProduct}`).set(headersFor(companyAdmin)).send({ pack: '1x1' }),
      request(app).post(`/api/v1/company/products/${theirProduct}/discontinue`).set(headersFor(companyAdmin)),
      request(app).post(`/api/v1/submissions/${sent}/withdraw`).set(headersFor(companyAdmin)),
      request(app)
        .delete(`/api/v1/members/${String(theirStaff!._id)}`)
        .set(headersFor(companyAdmin)),
    ]);
    refused.forEach((response) => expect({ status: response.status }).toEqual({ status: 404 }));

    // Their product's registration number cannot be claimed or reused either, and says so without naming them.
    const claim = await request(app)
      .post('/api/v1/company/products/claim')
      .set(headersFor(companyAdmin))
      .send({ registrationNo: 'O-1' })
      .expect(409);
    expect(claim.body.error.message).toBe('That product already belongs to another company.');
    expect(JSON.stringify(claim.body)).not.toContain('Other Pharma');
  });

  test('a company member is FORBIDDEN from clinic and platform routes, and sees no usage', async () => {
    const { reviewer, companyAdmin, doctor, patientId } = await theCast(22);
    const headers = { ...headersFor(companyAdmin), 'X-Location-Id': doctor.locationId };

    const routes: ['get' | 'post', string][] = [
      ['get', '/api/v1/practice'],
      ['get', '/api/v1/patients'],
      ['get', '/api/v1/visits'],
      ['get', '/api/v1/prescriptions'],
      ['get', '/api/v1/drugs?q=pan'],
      ['get', '/api/v1/drug-lists/clinic'],
      ['get', '/api/v1/notifications'],
      ['get', '/api/v1/companies'],
      ['post', `/api/v1/submissions/${patientId}/approve`],
      ['post', `/api/v1/submissions/${patientId}/reject`],
    ];
    const answers = await Promise.all(
      routes.map(async ([method, path]) => {
        const response = await request(app)[method](path).set(headers).send({});
        return { route: `${method} ${path}`, status: response.status, code: response.body.error?.code };
      }),
    );
    answers.forEach((answer) => expect(answer).toEqual({ route: answer.route, status: 403, code: 'FORBIDDEN' }));

    await catalog('D-1,Claimol,Claim,1mg,Tablet,10x10,Somebody');
    const row = await drapRow('D-1');
    await prescribe(doctor, patientId, { id: String(row._id), brand: 'Claimol', strength: '1mg', form: 'tab' });
    const claim = await request(app)
      .post('/api/v1/company/products/claim')
      .set(headersFor(companyAdmin))
      .send({ registrationNo: 'D-1' })
      .expect(201);
    await decide(reviewer, claim.body.data.submission.id, 'approve').expect(200);

    const products = (await request(app).get('/api/v1/company/products').set(headersFor(companyAdmin)).expect(200)).body
      .data;
    expect(products).toHaveLength(1);
    expect(Object.keys(products[0]).sort()).toEqual(
      ['brand', 'composition', 'form', 'id', 'latestSubmission', 'pack', 'registrationNo', 'status', 'strength'].sort(),
    );
    expect(JSON.stringify(products)).not.toMatch(/count|usage|doctor|lastUsed/i);
  });
});

/* ------------------------------------------------------------------ *
 * Staff
 * ------------------------------------------------------------------ */

describe('Staff', () => {
  test("a company's admin adds and removes its staff; it keeps one admin, and roles never change", async () => {
    const platformAdmin = await aPlatformAdmin('+923007730001');
    const { companyAdmin } = await aCompany(platformAdmin, '+923007730002');

    const editor = await aStaffMember(companyAdmin, '+923007730003', 'companyEditor');
    expect(
      (
        await request(app)
          .post('/api/v1/members')
          .set(headersFor(editor))
          .send({ phone: '+923007730009', role: 'companyEditor' })
      ).body.error.code,
    ).toBe('FORBIDDEN');

    const wrongRole = await request(app)
      .post('/api/v1/members')
      .set(headersFor(companyAdmin))
      .send({ phone: '+923007730004', role: 'reviewer' })
      .expect(400);
    expect(wrongRole.body.error.code).toBe('VALIDATION_ERROR');

    const team = (await request(app).get('/api/v1/members').set(headersFor(companyAdmin)).expect(200)).body.data;
    expect(team.map((member: { role: string }) => member.role).sort()).toEqual(['companyAdmin', 'companyEditor']);
    const me = team.find((member: { userId: string }) => member.userId === companyAdmin.userId);
    const editorRow = team.find((member: { userId: string }) => member.userId === editor.userId);

    const last = await request(app).delete(`/api/v1/members/${me.id}`).set(headersFor(companyAdmin)).expect(409);
    expect(last.body.error.code).toBe('LAST_ADMIN');

    const changed = await request(app)
      .patch(`/api/v1/members/${editorRow.id}`)
      .set(headersFor(companyAdmin))
      .send({ role: 'companyAdmin' })
      .expect(403);
    expect(changed.body.error.code).toBe('FORBIDDEN');
    expect((await Membership.findById(editorRow.id))?.role).toBe('companyEditor');

    await request(app)
      .post('/api/v1/members')
      .set(headersFor(companyAdmin))
      .send({ phone: '+923007730005', role: 'companyAdmin' })
      .expect(201);
    await request(app).delete(`/api/v1/members/${me.id}`).set(headersFor(companyAdmin)).expect(200);
    await request(app)
      .delete(`/api/v1/members/${editorRow.id}`)
      .set(headersFor(await signIn('+923007730005')))
      .expect(200);
    expect(await AuditLog.countDocuments({ action: 'member.remove' })).toBe(2);
  });

  test("RxDictate's admin adds the platform's staff, and the platform keeps one admin", async () => {
    const platformAdmin = await aPlatformAdmin('+923007730101');
    const reviewer = await aStaffMember(platformAdmin, '+923007730102', 'reviewer');
    await aStaffMember(platformAdmin, '+923007730103', 'contentManager');

    expect(
      (
        await request(app)
          .post('/api/v1/members')
          .set(headersFor(reviewer))
          .send({ phone: '+923007730104', role: 'reviewer' })
      ).body.error.code,
    ).toBe('FORBIDDEN');
    const clinicRole = await request(app)
      .post('/api/v1/members')
      .set(headersFor(platformAdmin))
      .send({ phone: '+923007730105', role: 'companyAdmin' })
      .expect(400);
    expect(clinicRole.body.error.code).toBe('VALIDATION_ERROR');

    const team = (await request(app).get('/api/v1/members').set(headersFor(platformAdmin)).expect(200)).body.data;
    expect(team.map((member: { role: string }) => member.role).sort()).toEqual([
      'contentManager',
      'platformAdmin',
      'reviewer',
    ]);
    const admin = team.find((member: { role: string }) => member.role === 'platformAdmin');
    expect(
      (await request(app).delete(`/api/v1/members/${admin.id}`).set(headersFor(platformAdmin)).expect(409)).body.error.code,
    ).toBe('LAST_ADMIN');
  });
});

/* ------------------------------------------------------------------ *
 * Review
 * ------------------------------------------------------------------ */

describe('Review', () => {
  test('a new product is live only once approved: national, active, owned by the company, under its name', async () => {
    const { reviewer, company, companyAdmin, doctor } = await theCast(41);
    const before = await Drug.countDocuments();

    const sent = await sendProduct(companyAdmin).expect(201);
    expect(sent.body.data.submission).toMatchObject({ type: 'drug.create', status: 'pending', drugId: null });
    expect(await Drug.countDocuments()).toBe(before);
    expect(await searchAs(doctor, 'zentra')).toEqual([]);

    const approved = await decide(reviewer, sent.body.data.submission.id, 'approve').expect(200);
    expect(approved.body.data.status).toBe('approved');

    const row = await drapRow('C-0001');
    expect(row).toMatchObject({
      scope: 'national',
      status: 'active',
      source: 'company',
      company: 'Acme Pharma',
      brand: 'Zentra',
      generic: 'Zentramol 250mg',
    });
    expect(String(row.companyId)).toBe(company.id);
    expect(approved.body.data.resultDrugId).toBe(String(row._id));
    expect(await searchAs(doctor, 'zentra')).toEqual(['Zentra']);
    expect(await AuditLog.countDocuments({ action: 'drug.create', entityId: row._id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'submission.approve' })).toBe(1);
  });

  test("a change and a discontinuation do exactly that, and nothing a doctor sees changes before they're approved", async () => {
    const { reviewer, companyAdmin, doctor } = await theCast(42);
    await decide(reviewer, (await sendProduct(companyAdmin).expect(201)).body.data.submission.id, 'approve').expect(200);
    const row = await drapRow('C-0001');

    const change = await request(app)
      .patch(`/api/v1/company/products/${String(row._id)}`)
      .set(headersFor(companyAdmin))
      .send({ brand: 'Zentra Forte', pack: '2x10' })
      .expect(201);
    expect(change.body.data.submission.payload).toEqual({ brand: 'Zentra Forte', pack: '2x10' });
    expect(change.body.data.current.brand).toBe('Zentra');
    expect((await Drug.findById(row._id))?.brand).toBe('Zentra');
    expect(await searchAs(doctor, 'zentra forte')).toEqual([]);

    // One change at a time.
    await request(app)
      .post(`/api/v1/company/products/${String(row._id)}/discontinue`)
      .set(headersFor(companyAdmin))
      .expect(409);

    await decide(reviewer, change.body.data.submission.id, 'approve').expect(200);
    const changed = await Drug.findById(row._id);
    expect(changed).toMatchObject({ brand: 'Zentra Forte', pack: '2x10', strength: '250mg', status: 'active' });
    expect(await searchAs(doctor, 'zentra forte')).toEqual(['Zentra Forte']);

    const stop = await request(app)
      .post(`/api/v1/company/products/${String(row._id)}/discontinue`)
      .set(headersFor(companyAdmin))
      .expect(201);
    expect((await Drug.findById(row._id))?.status).toBe('active');
    await decide(reviewer, stop.body.data.submission.id, 'approve').expect(200);
    expect((await Drug.findById(row._id))?.status).toBe('discontinued');
    expect(String((await Drug.findById(row._id))?._id)).toBe(String(row._id));

    const products = (await request(app).get('/api/v1/company/products').set(headersFor(companyAdmin)).expect(200)).body
      .data;
    expect(products[0]).toMatchObject({
      status: 'discontinued',
      latestSubmission: { type: 'drug.discontinue', status: 'approved' },
    });
  });

  test('rejecting and asking for changes need a note, which the sender reads', async () => {
    const { reviewer, companyAdmin } = await theCast(43);
    const { id } = (await sendProduct(companyAdmin).expect(201)).body.data.submission;

    const attempts = await Promise.all(
      (['reject', 'request-changes'] as const).flatMap((action) => [
        decide(reviewer, id, action, {}),
        decide(reviewer, id, action, { note: '   ' }),
      ]),
    );
    attempts.forEach((attempt) => {
      expect({ status: attempt.status, code: attempt.body.error?.code }).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    });
    expect((await Submission.findById(id))?.status).toBe('pending');

    await decide(reviewer, id, 'reject', { note: 'This is not registered with DRAP.' }).expect(200);
    const seen = (await request(app).get(`/api/v1/submissions/${id}`).set(headersFor(companyAdmin)).expect(200)).body.data;
    expect(seen.submission).toMatchObject({
      status: 'rejected',
      note: 'This is not registered with DRAP.',
      reviewerId: null,
    });
    expect(seen.duplicates).toEqual([]);
    expect(seen.submission.history.map((step: { step: string; by: string | null }) => [step.step, step.by])).toEqual([
      ['submitted', companyAdmin.userId],
      ['rejected', null],
    ]);
  });

  test('a submission sent back for changes is edited and sent again as the same one, with its history kept', async () => {
    const { reviewer, companyAdmin } = await theCast(44);
    const { id } = (await sendProduct(companyAdmin).expect(201)).body.data.submission;

    // Only one sent back can be sent again.
    expect(
      (
        await request(app)
          .patch(`/api/v1/submissions/${id}`)
          .set(headersFor(companyAdmin))
          .send({ payload: PRODUCT })
          .expect(409)
      ).body.error.code,
    ).toBe('SUBMISSION_WRONG_STATUS');

    await decide(reviewer, id, 'request-changes', { note: 'The strength is per 5ml, not per tablet.' }).expect(200);
    const bad = await request(app)
      .patch(`/api/v1/submissions/${id}`)
      .set(headersFor(companyAdmin))
      .send({ payload: { ...PRODUCT, brand: '' } })
      .expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const again = await request(app)
      .patch(`/api/v1/submissions/${id}`)
      .set(headersFor(companyAdmin))
      .send({ payload: { ...PRODUCT, form: 'syp', strength: '250mg/5ml' } })
      .expect(200);
    expect(again.body.data).toMatchObject({
      id,
      status: 'pending',
      note: null,
      payload: { form: 'syp', strength: '250mg/5ml' },
    });
    expect(again.body.data.history.map((step: { step: string }) => step.step)).toEqual([
      'submitted',
      'changesRequested',
      'resubmitted',
    ]);
    expect(again.body.data.history[1].note).toBe('The strength is per 5ml, not per tablet.');
    expect(await Submission.countDocuments()).toBe(1);

    const asReviewer = (await request(app).get(`/api/v1/submissions/${id}`).set(headersFor(reviewer)).expect(200)).body.data;
    expect(asReviewer.submission.history[1].by).toBe(reviewer.userId);

    await decide(reviewer, id, 'approve').expect(200);
    expect(await drapRow('C-0001')).toMatchObject({ form: 'syp', strength: '250mg/5ml' });
  });

  test('a withdrawn submission can never be approved', async () => {
    const { reviewer, companyAdmin } = await theCast(45);
    const { id } = (await sendProduct(companyAdmin).expect(201)).body.data.submission;

    await request(app).post(`/api/v1/submissions/${id}/withdraw`).set(headersFor(companyAdmin)).expect(200);
    const refused = await decide(reviewer, id, 'approve').expect(409);
    expect(refused.body.error).toMatchObject({ code: 'SUBMISSION_WRONG_STATUS', details: { status: 'withdrawn' } });
    expect(await Drug.countDocuments({ drapRegNo: 'C-0001' })).toBe(0);
    await request(app).post(`/api/v1/submissions/${id}/withdraw`).set(headersFor(companyAdmin)).expect(409);
  });

  test('a reviewer sees likely duplicates; a duplicate is rejected with a reason, and the company claims it instead', async () => {
    const { reviewer, companyAdmin } = await theCast(46);
    await catalog('D-77,Zentra,Zentramol,250mg,Film Coated Tablet,10x10,Old Maker');
    const existing = await drapRow('D-77');

    // The same registration number is refused when it is sent, with what to do instead.
    const same = await sendProduct(companyAdmin, { ...PRODUCT, registrationNo: 'D-77' }).expect(409);
    expect(same.body.error).toMatchObject({ code: 'CONFLICT', details: { drugId: String(existing._id), claimable: true } });

    // The same brand, strength and form under another number reaches review, flagged.
    const { id } = (await sendProduct(companyAdmin).expect(201)).body.data.submission;
    const seen = (await request(app).get(`/api/v1/submissions/${id}`).set(headersFor(reviewer)).expect(200)).body.data;
    expect(seen.duplicates.map((drug: { id: string }) => drug.id)).toEqual([String(existing._id)]);

    await decide(reviewer, id, 'reject', {
      note: 'Already in the catalog as D-77; claim it.',
      duplicateOfId: String(existing._id),
    }).expect(200);
    const rejected = (await request(app).get(`/api/v1/submissions/${id}`).set(headersFor(companyAdmin)).expect(200)).body
      .data;
    expect(rejected.submission.duplicateOfId).toBe(String(existing._id));

    const claim = await request(app)
      .post('/api/v1/company/products/claim')
      .set(headersFor(companyAdmin))
      .send({ registrationNo: 'D-77' })
      .expect(201);
    expect(claim.body.data.current.id).toBe(String(existing._id));
  });

  test('a sender cannot decide, and a reviewer cannot send', async () => {
    const { reviewer, companyAdmin } = await theCast(47);
    const { id } = (await sendProduct(companyAdmin).expect(201)).body.data.submission;
    expect((await decide(companyAdmin, id, 'approve').expect(403)).body.error.code).toBe('FORBIDDEN');
    expect((await sendProduct(reviewer).expect(403)).body.error.code).toBe('FORBIDDEN');
  });
});

/* ------------------------------------------------------------------ *
 * Claim, publish and merge
 * ------------------------------------------------------------------ */

describe('Claim, publish and merge', () => {
  test('a claim gives the company the DRAP row with its id, lists and usage unchanged, and the next import leaves it alone', async () => {
    const { reviewer, company, companyAdmin, doctor, patientId } = await theCast(51);
    await catalog('D-10,Claimol,Claimolol,10mg,Tablet,10x10,Old Maker');
    const row = await drapRow('D-10');
    const drug = { id: String(row._id), brand: 'Claimol', strength: '10mg', form: 'tab' };

    await request(app).put(`/api/v1/drug-lists/clinic/items/${drug.id}`).set(headersFor(doctor)).send({}).expect(200);
    await request(app).put(`/api/v1/drug-lists/me/items/${drug.id}`).set(headersFor(doctor)).send({}).expect(200);
    await prescribe(doctor, patientId, drug);
    const usageBefore = await DrugUsage.findOne({ drugId: row._id });
    expect(usageBefore?.count).toBe(1);

    const claim = await request(app)
      .post('/api/v1/company/products/claim')
      .set(headersFor(companyAdmin))
      .send({ registrationNo: 'D-10' })
      .expect(201);
    expect((await Drug.findById(row._id))?.companyId).toBeNull();
    await decide(reviewer, claim.body.data.submission.id, 'approve').expect(200);

    const claimed = await Drug.findById(row._id);
    expect(claimed).toMatchObject({ source: 'company', company: 'Acme Pharma', brand: 'Claimol', status: 'active' });
    expect(String(claimed?.companyId)).toBe(company.id);
    const lists = await DrugList.find({ practiceId: doctor.practiceId });
    expect(lists).toHaveLength(2);
    lists.forEach((list) => expect(list.items.map((item) => String(item.drugId))).toEqual([drug.id]));
    const usageAfter = await DrugUsage.findOne({ drugId: row._id });
    expect({ count: usageAfter?.count, lastUsedAt: usageAfter?.lastUsedAt }).toEqual({
      count: usageBefore?.count,
      lastUsedAt: usageBefore?.lastUsedAt,
    });

    // A re-import does not undo what the company's reviewed submissions say.
    const summary = await catalog('D-10,Claimol Old,Claimolol,10mg,Tablet,10x10,Old Maker');
    expect(summary.skipped).toEqual([expect.objectContaining({ registrationNo: 'D-10' })]);
    expect((await Drug.findById(row._id))?.brand).toBe('Claimol');
  });

  test('a published proposal becomes national with the same id, so every list keeps it', async () => {
    const { reviewer, doctor } = await theCast(52);
    const item = (
      await request(app)
        .post('/api/v1/drugs')
        .set(headersFor(doctor))
        .send({ brand: 'Clinic Syrup', form: 'syp', for: 'clinic' })
        .expect(201)
    ).body.data.drug;

    const proposed = await request(app).post(`/api/v1/drugs/${item.id}/propose`).set(headersFor(doctor)).expect(201);
    expect(proposed.body.data).toMatchObject({ type: 'drug.propose', status: 'pending', drugId: item.id });
    expect(
      (await request(app).post(`/api/v1/drugs/${item.id}/propose`).set(headersFor(doctor)).expect(409)).body.error.code,
    ).toBe('CONFLICT');

    const pending = (await request(app).get('/api/v1/drug-lists/clinic').set(headersFor(doctor)).expect(200)).body.data[0];
    expect(pending).toMatchObject({
      drug: { id: item.id, scope: 'clinic' },
      proposal: { status: 'pending', type: 'drug.propose' },
    });

    const needsDecision = await decide(reviewer, proposed.body.data.id, 'approve').expect(400);
    expect(needsDecision.body.error.code).toBe('VALIDATION_ERROR');
    await decide(reviewer, proposed.body.data.id, 'approve', { decision: 'publish' }).expect(200);

    const row = await Drug.findById(item.id);
    expect(row).toMatchObject({ scope: 'national', practiceId: null, status: 'active' });
    const after = (await request(app).get('/api/v1/drug-lists/clinic').set(headersFor(doctor)).expect(200)).body.data[0];
    expect(after).toMatchObject({ drug: { id: item.id, scope: 'national' }, proposal: { status: 'approved' } });

    const { doctor: elsewhere } = await aClinic('+923007752099');
    expect(await searchAs(elsewhere, 'clinic syrup')).toEqual(['Clinic Syrup']);
  });

  test("merging a proposal moves list items and usage to the national row and retires the clinic's; prescriptions are untouched", async () => {
    const { reviewer, doctor, patientId } = await theCast(53);
    await catalog('D-20,Panadol,Paracetamol,500mg,Tablet,10x10,GSK');
    const national = await drapRow('D-20');
    const item = (
      await request(app)
        .post('/api/v1/drugs')
        .set(headersFor(doctor))
        .send({ brand: 'Panadol Local', strength: '500mg', form: 'tab', for: 'clinic' })
        .expect(201)
    ).body.data.drug;
    await request(app)
      .put(`/api/v1/drug-lists/me/items/${item.id}`)
      .set(headersFor(doctor))
      .send({ usual: { durationDays: 3 } })
      .expect(200);
    const rxId = await prescribe(doctor, patientId, { id: item.id, brand: 'Panadol Local', strength: '500mg', form: 'tab' });
    const rxBefore = (await Prescription.findById(rxId))!.toObject().sections.medicines;

    const proposed = (await request(app).post(`/api/v1/drugs/${item.id}/propose`).set(headersFor(doctor)).expect(201)).body
      .data;
    // Nothing moves before a decision.
    expect(await DrugUsage.countDocuments({ drugId: item.id })).toBe(1);

    const notNational = await decide(reviewer, proposed.id, 'approve', { decision: 'merge', intoDrugId: item.id }).expect(
      400,
    );
    expect(notNational.body.error.code).toBe('VALIDATION_ERROR');
    expect((await Submission.findById(proposed.id))?.status).toBe('pending');

    const merged = await decide(reviewer, proposed.id, 'approve', {
      decision: 'merge',
      intoDrugId: String(national._id),
    }).expect(200);
    expect(merged.body.data.resultDrugId).toBe(String(national._id));

    const retired = await Drug.findById(item.id);
    expect(retired).toMatchObject({ status: 'discontinued', scope: 'clinic' });
    expect(String(retired?.mergedIntoId)).toBe(String(national._id));

    const lists = await DrugList.find({ practiceId: doctor.practiceId });
    lists.forEach((list) => {
      expect(list.items.map((entry) => String(entry.drugId))).toEqual([String(national._id)]);
    });
    const mine = lists.find((list) => String(list.ownerId) === doctor.userId);
    expect(mine?.items[0].usual).toEqual({ durationDays: 3 });

    expect(await DrugUsage.countDocuments({ drugId: item.id })).toBe(0);
    expect((await DrugUsage.findOne({ drugId: national._id, doctorId: doctor.userId }))?.count).toBe(1);

    expect((await Prescription.findById(rxId))!.toObject().sections.medicines).toEqual(rxBefore);
    expect(await AuditLog.countDocuments({ action: 'drug.merge', entityId: item.id })).toBe(1);
  });

  test("a company's proposal of a row it doesn't own, or a doctor's own typed row, is refused", async () => {
    const { companyAdmin, doctor } = await theCast(54);
    const own = (
      await request(app).post('/api/v1/drugs').set(headersFor(doctor)).send({ brand: 'Mine Only', for: 'me' }).expect(201)
    ).body.data.drug;
    expect(
      (await request(app).post(`/api/v1/drugs/${own.id}/propose`).set(headersFor(doctor)).expect(404)).body.error.code,
    ).toBe('NOT_FOUND');
    expect(
      (await request(app).post(`/api/v1/drugs/${own.id}/propose`).set(headersFor(companyAdmin)).expect(403)).body.error.code,
    ).toBe('FORBIDDEN');
  });
});

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

describe('Products by CSV', () => {
  const CSV_HEADER = 'registrationNo,brand,composition,strength,form,pack,company';

  test('the check changes nothing and says what each row would become, or what is wrong with it', async () => {
    const { platformAdmin, reviewer, companyAdmin } = await theCast(61);
    const { companyAdmin: other } = await aCompany(platformAdmin, '+923007761099', 'Other Pharma');
    await decide(reviewer, (await sendProduct(companyAdmin).expect(201)).body.data.submission.id, 'approve').expect(200);
    await decide(
      reviewer,
      (await sendProduct(other, { ...PRODUCT, brand: 'Theirs', registrationNo: 'O-9' }).expect(201)).body.data.submission.id,
      'approve',
    ).expect(200);
    await catalog('D-30,Drapol,Drap,5mg,Tablet,10x10,Old Maker');
    const submissionsBefore = await Submission.countDocuments();
    const drugsBefore = await Drug.countDocuments();

    const csv = [
      CSV_HEADER,
      'N-1,Newmol,"Newmol 5mg, buffered",5mg,Film Coated Tablet,10x10,ignored',
      'C-0001,Zentra,Zentramol 250mg,250mg,Tablet,20x10,',
      'C-0001,Zentra,Zentramol 250mg,250mg,Tablet,10x10,',
      'D-30,Drapol,Drap,5mg,Tablet,10x10,',
      'O-9,Theirs,x,1mg,Tablet,1x1,',
      'N-2,,nothing,1mg,Tablet,1x1,',
    ].join('\n');

    const checked = await request(app)
      .post('/api/v1/company/products/csv/check')
      .set(headersFor(companyAdmin))
      .send({ csv })
      .expect(200);
    expect(
      checked.body.data.rows.map((row: { line: number; outcome: string | null; problems: string[] }) => [
        row.line,
        row.outcome,
        row.problems.length > 0,
      ]),
    ).toEqual([
      [2, 'new', false],
      [3, 'update', false],
      [4, null, true],
      [5, 'claim', false],
      [6, null, true],
      [7, null, true],
    ]);
    expect(checked.body.data.rows[4].problems).toEqual(['this registration number belongs to another company']);
    expect(checked.body.data.counts).toEqual({ new: 1, update: 1, claim: 1, unchanged: 0, problems: 3 });

    expect(await Submission.countDocuments()).toBe(submissionsBefore);
    expect(await Drug.countDocuments()).toBe(drugsBefore);

    // A file with problems sends nothing.
    await request(app).post('/api/v1/company/products/csv').set(headersFor(companyAdmin)).send({ csv }).expect(400);
    expect(await Submission.countDocuments()).toBe(submissionsBefore);
  });

  test('more than 500 rows is refused', async () => {
    const { companyAdmin } = await theCast(62);
    const rows = Array.from({ length: COMPANY_CSV_MAX_ROWS + 1 }, (_, at) => `R-${at},Brand ${at},,,Tablet,,`);
    const csv = [CSV_HEADER, ...rows].join('\n');

    const refused = await request(app)
      .post('/api/v1/company/products/csv/check')
      .set(headersFor(companyAdmin))
      .send({ csv })
      .expect(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');
    await request(app).post('/api/v1/company/products/csv').set(headersFor(companyAdmin)).send({ csv }).expect(400);

    const fine = [CSV_HEADER, ...rows.slice(0, COMPANY_CSV_MAX_ROWS)].join('\n');
    const checked = await request(app)
      .post('/api/v1/company/products/csv/check')
      .set(headersFor(companyAdmin))
      .send({ csv: fine })
      .expect(200);
    expect(checked.body.data.counts.new).toBe(COMPANY_CSV_MAX_ROWS);
  });

  test('each row becomes its own submission, grouped by an upload id the reviewer can filter on', async () => {
    const { reviewer, companyAdmin } = await theCast(63);
    await decide(reviewer, (await sendProduct(companyAdmin).expect(201)).body.data.submission.id, 'approve').expect(200);
    await catalog('D-40,Drapol,Drap,5mg,Tablet,10x10,Old Maker');

    const csv = [
      CSV_HEADER,
      'N-1,Newmol,Newmol,5mg,Tablet,10x10,',
      'N-2,Twomol,Twomol,5mg,Capsule,10x10,',
      'C-0001,Zentra,Zentramol 250mg,250mg,Tablet,30x10,',
      'D-40,Drapol,Drap,5mg,Tablet,10x10,',
    ].join('\n');
    const sent = await request(app)
      .post('/api/v1/company/products/csv')
      .set(headersFor(companyAdmin))
      .send({ csv })
      .expect(201);
    expect(sent.body.data.submissionIds).toHaveLength(4);
    expect(sent.body.data.counts).toMatchObject({ new: 2, update: 1, claim: 1, problems: 0 });

    const queue = await request(app)
      .get('/api/v1/submissions')
      .query({ uploadId: sent.body.data.uploadId, limit: 100 })
      .set(headersFor(reviewer))
      .expect(200);
    expect(queue.body.data.map((row: { type: string }) => row.type).sort()).toEqual([
      'drug.claim',
      'drug.create',
      'drug.create',
      'drug.update',
    ]);
    expect(queue.body.data.find((row: { type: string }) => row.type === 'drug.update').payload).toEqual({ pack: '30x10' });
    expect(await Drug.countDocuments({ drapRegNo: { $in: ['N-1', 'N-2'] } })).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

describe('The queue', () => {
  test('a reviewer sees every organisation, open and oldest first; each sender sees only its own', async () => {
    const { reviewer, company, companyAdmin, doctor } = await theCast(71);
    const first = (await sendProduct(companyAdmin).expect(201)).body.data.submission.id;
    const item = (
      await request(app).post('/api/v1/drugs').set(headersFor(doctor)).send({ brand: 'Local', for: 'clinic' }).expect(201)
    ).body.data.drug;
    const second = (await request(app).post(`/api/v1/drugs/${item.id}/propose`).set(headersFor(doctor)).expect(201)).body
      .data.id;
    const third = (await sendProduct(companyAdmin, { ...PRODUCT, registrationNo: 'C-0002', brand: 'Other' }).expect(201))
      .body.data.submission.id;
    await decide(reviewer, first, 'reject', { note: 'No.' }).expect(200);

    const all = (await request(app).get('/api/v1/submissions').set(headersFor(reviewer)).expect(200)).body.data;
    expect(all.map((row: { id: string }) => row.id)).toEqual([second, third, first]);

    const byCompany = (
      await request(app)
        .get('/api/v1/submissions')
        .query({ organisationId: company.id, status: 'pending' })
        .set(headersFor(reviewer))
        .expect(200)
    ).body.data;
    expect(byCompany.map((row: { id: string }) => row.id)).toEqual([third]);

    const clinics = (await request(app).get('/api/v1/submissions').set(headersFor(doctor)).expect(200)).body.data;
    expect(clinics.map((row: { id: string }) => row.id)).toEqual([second]);
    const companies = (
      await request(app)
        .get('/api/v1/submissions')
        .query({ organisationId: doctor.practiceId })
        .set(headersFor(companyAdmin))
        .expect(200)
    ).body.data;
    expect(companies.map((row: { id: string }) => row.id)).toEqual([third, first]);
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

  test('the reviewer and the sending company hear `submissions`, with no location; nobody else does', async () => {
    const { reviewer, companyAdmin, doctor } = await theCast(81);
    const platformSocket = await signedIn(live.url, reviewer);
    const companySocket = await signedIn(live.url, companyAdmin);
    const clinicSocket = await signedIn(live.url, doctor, doctor.locationId);
    opened.push(platformSocket, companySocket, clinicSocket);

    const { id } = (await sendProduct(companyAdmin).expect(201)).body.data.submission;
    const heard = (message: { type: string; topic?: string; id?: string }) =>
      message.type === 'changed' && message.topic === 'submissions' && message.id === id;
    await platformSocket.next(heard);
    await companySocket.next(heard);
    expect(clinicSocket.inbox.some((message) => heard(message as { type: string; topic?: string; id?: string }))).toBe(
      false,
    );
  });

  test('a company that is suspended has its open apps closed', async () => {
    const { platformAdmin, company, companyAdmin } = await theCast(82);
    const socket = await signedIn(live.url, companyAdmin);
    opened.push(socket);

    await request(app).post(`/api/v1/companies/${company.id}/suspend`).set(headersFor(platformAdmin)).expect(200);
    expect(await socket.closed).toEqual({ code: 1008, reason: 'ORGANISATION_SUSPENDED' });
  });
});
