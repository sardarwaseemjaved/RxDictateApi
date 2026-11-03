import request from 'supertest';
import { Types } from 'mongoose';
import app from '../../src/app';
import setupTestDB from '../utils/setupTestDB';
import { aClinic, aPa, aPlatformAdmin, headersFor, type SignedIn } from '../fixtures/clinic.fixture';
import { AuditLog, Location, Membership, Practice, User } from '../../src/models';
import { actionsFor } from '../../src/core/permissions';
import { backfillOrganisationTypes, initPlatform, PLATFORM_NAME } from '../../src/services/organisation.service';

setupTestDB();

const meOf = async (actor: SignedIn) =>
  (
    await request(app)
      .get('/api/v1/me')
      .set({ Authorization: `Bearer ${actor.accessToken}` })
      .expect(200)
  ).body.data;

/** A membership row as a script or a later feature might write it, without any route's checks. */
const aMembership = (practiceId: Types.ObjectId, role: string) => {
  const someone = new Types.ObjectId();
  return Membership.create({
    userId: new Types.ObjectId(),
    practiceId,
    role,
    locationIds: [],
    status: 'active',
    addedBy: someone,
    createdBy: someone,
  });
};

describe('Organisation types', () => {
  describe('existing practices', () => {
    test('read as clinics after the backfill, and a second run changes nothing', async () => {
      const { doctor } = await aClinic('+923001110001');
      const _id = new Types.ObjectId(doctor.practiceId);

      // As it was stored before organisations had types.
      await Practice.collection.updateOne({ _id }, { $unset: { type: '' } });
      expect(await Practice.collection.findOne({ _id })).not.toHaveProperty('type');

      expect(await backfillOrganisationTypes()).toBe(1);
      expect(await Practice.collection.findOne({ _id })).toHaveProperty('type', 'clinic');
      expect(await backfillOrganisationTypes()).toBe(0);

      const [membership] = (await meOf(doctor)).memberships;
      expect(membership).toMatchObject({ practiceId: doctor.practiceId, organisationType: 'clinic', role: 'doctor' });
    });

    test('a clinic made at sign-up is a clinic', async () => {
      const { doctor } = await aClinic('+923001110002');
      expect((await Practice.findById(doctor.practiceId))!.type).toBe('clinic');
    });
  });

  describe('platform:init', () => {
    test('makes one platform organisation and one admin, and running it twice changes nothing', async () => {
      const phone = '+923001110003';
      const first = await initPlatform(phone, 'Ops');
      expect(first).toMatchObject({ createdOrganisation: true, createdUser: true, grantedAdmin: true });

      const state = async () => ({
        platforms: await Practice.countDocuments({ type: 'platform' }),
        users: await User.countDocuments({ phone }),
        memberships: await Membership.find({ practiceId: first.organisationId }).select('role status -_id').lean(),
        audited: await AuditLog.find({ practiceId: first.organisationId }).sort({ _id: 1 }).select('action -_id').lean(),
      });
      const once = await state();
      expect(once).toEqual({
        platforms: 1,
        users: 1,
        memberships: [{ role: 'platformAdmin', status: 'active' }],
        audited: [{ action: 'organisation.create' }, { action: 'member.add' }],
      });

      const second = await initPlatform(phone, 'Ops');
      expect(second).toEqual({
        organisationId: first.organisationId,
        userId: first.userId,
        createdOrganisation: false,
        createdUser: false,
        grantedAdmin: false,
      });
      expect(await state()).toEqual(once);
    });

    test('another phone joins the same platform, and a doctor keeps their clinic beside it', async () => {
      const { doctor } = await aClinic('+923001110004');
      const first = await initPlatform('+923001110005');
      const second = await initPlatform(doctor.phone);

      expect(second.organisationId).toEqual(first.organisationId);
      expect(second.createdUser).toBe(false);
      expect(await Practice.countDocuments({ type: 'platform' })).toBe(1);

      const { memberships } = await meOf(doctor);
      expect(memberships.map((m: { organisationType: string; role: string }) => [m.organisationType, m.role])).toEqual(
        expect.arrayContaining([
          ['clinic', 'doctor'],
          ['platform', 'platformAdmin'],
        ]),
      );
    });

    test('the database allows only one platform', async () => {
      const { organisationId, userId } = await initPlatform('+923001110006');
      await expect(
        Practice.create({ type: 'platform', name: 'Another', ownerId: userId, createdBy: userId }),
      ).rejects.toThrow(/duplicate key/);
      expect(await Practice.countDocuments({ type: 'platform' })).toBe(1);
      expect(String((await Practice.findOne({ type: 'platform' }))!._id)).toBe(String(organisationId));
    });

    test('refuses something that is not a phone number', async () => {
      await expect(initPlatform('0300 1234567')).rejects.toMatchObject({ code: 'PHONE_INVALID' });
      expect(await Practice.countDocuments({ type: 'platform' })).toBe(0);
    });
  });

  describe('a platform member', () => {
    test('is FORBIDDEN from the clinic routes, all turned away by the tenancy middleware', async () => {
      const admin = await aPlatformAdmin('+923001110007');
      const headers = { ...headersFor(admin), 'X-Location-Id': new Types.ObjectId().toHexString() };

      const clinicRoutes: ['get' | 'post', string][] = [
        ['get', '/api/v1/practice'],
        ['get', '/api/v1/locations'],
        ['post', '/api/v1/locations'],
        ['get', '/api/v1/members'],
        ['get', '/api/v1/patients'],
        ['post', '/api/v1/patients'],
        ['get', '/api/v1/visits'],
        ['get', '/api/v1/prescriptions'],
        ['post', '/api/v1/prescriptions'],
        ['get', '/api/v1/drugs?q=panadol'],
        ['get', '/api/v1/appointments?from=2026-11-01&to=2026-11-30'],
        ['get', '/api/v1/follow-ups'],
        ['get', '/api/v1/notifications'],
        ['get', '/api/v1/templates'],
      ];

      const answers = await Promise.all(
        clinicRoutes.map(async ([method, path]) => {
          const response = await request(app)[method](path).set(headers).send({});
          return { route: `${method.toUpperCase()} ${path}`, status: response.status, code: response.body.error?.code };
        }),
      );
      answers.forEach((answer) => {
        expect(answer).toEqual({ route: answer.route, status: 403, code: 'FORBIDDEN' });
      });
    });

    test('still learns nothing about a clinic that is not theirs', async () => {
      const { doctor } = await aClinic('+923001110008');
      const admin = await aPlatformAdmin('+923001110009');
      const response = await request(app)
        .get('/api/v1/patients')
        .set({ ...headersFor(admin), 'X-Practice-Id': doctor.practiceId })
        .expect(403);
      expect(response.body.error.code).toBe('NOT_MEMBER');
    });
  });

  describe('roles by organisation type', () => {
    test('a clinic refuses a platform role, through the team routes or written directly', async () => {
      const { doctor } = await aClinic('+923001110010');

      const added = await request(app)
        .post('/api/v1/members')
        .set(headersFor(doctor))
        .send({ phone: '+923001110011', role: 'platformAdmin', locationIds: [doctor.locationId] })
        .expect(400);
      expect(added.body.error.code).toBe('VALIDATION_ERROR');

      const pa = await aPa(doctor, '+923001110012');
      const memberId = (await Membership.findOne({ userId: pa.userId }))!._id;
      const changed = await request(app)
        .patch(`/api/v1/members/${memberId}`)
        .set(headersFor(doctor))
        .send({ role: 'reviewer' })
        .expect(400);
      expect(changed.body.error.code).toBe('VALIDATION_ERROR');

      await expect(aMembership(new Types.ObjectId(doctor.practiceId), 'contentManager')).rejects.toThrow(
        /contentManager is not a role in this kind of organisation/,
      );
      expect(await Membership.countDocuments({ practiceId: doctor.practiceId, role: { $nin: ['doctor', 'pa'] } })).toBe(0);
    });

    test('the platform refuses a clinic role, a company refuses every role, and nowhere takes a role for an organisation that does not exist', async () => {
      const { organisationId, userId } = await initPlatform('+923001110013');
      await expect(aMembership(organisationId, 'doctor')).rejects.toThrow(/doctor is not a role/);
      await expect(aMembership(organisationId, 'pa')).rejects.toThrow(/pa is not a role/);
      await expect(aMembership(organisationId, 'reviewer')).resolves.toBeTruthy();

      const company = await Practice.create({
        type: 'company',
        name: 'A medicine company',
        ownerId: userId,
        createdBy: userId,
      });
      await expect(aMembership(company._id, 'doctor')).rejects.toThrow(/not a role/);
      await expect(aMembership(company._id, 'platformAdmin')).rejects.toThrow(/not a role/);

      await expect(aMembership(new Types.ObjectId(), 'doctor')).rejects.toThrow(/not a role/);
    });
  });
});

describe('GET /me', () => {
  test("each membership's can is its role's row of the table: a doctor, an assistant, a platform admin", async () => {
    const { doctor } = await aClinic('+923001110020');
    const pa = await aPa(doctor, '+923001110021');
    const admin = await aPlatformAdmin('+923001110022');

    const [asDoctor] = (await meOf(doctor)).memberships;
    expect(asDoctor).toMatchObject({ organisationType: 'clinic', role: 'doctor', can: actionsFor('doctor') });
    expect(asDoctor.can).toEqual(
      expect.arrayContaining(['prescription.approve', 'settings.read', 'settings.organisation.update']),
    );
    expect(asDoctor.can).not.toContain('settings.platform.update');

    const [asPa] = (await meOf(pa)).memberships;
    expect(asPa).toMatchObject({ organisationType: 'clinic', role: 'pa', can: actionsFor('pa') });
    expect(asPa.can).toEqual(expect.arrayContaining(['patient.create', 'prescription.print', 'settings.read']));
    expect(asPa.can).not.toContain('prescription.approve');
    expect(asPa.can).not.toContain('settings.organisation.update');

    const [asAdmin] = (await meOf(admin)).memberships;
    expect(asAdmin).toMatchObject({
      practiceName: PLATFORM_NAME,
      organisationType: 'platform',
      role: 'platformAdmin',
      can: ['settings.read', 'settings.platform.update'],
      locationIds: [],
      locations: [],
    });
  });
});

describe('Fields for targeting', () => {
  test('specialties round-trip through /me, each once, and a made-up one is refused', async () => {
    const { doctor } = await aClinic('+923001110030');
    const auth = { Authorization: `Bearer ${doctor.accessToken}` };

    expect((await meOf(doctor)).specialties).toEqual([]);

    const set = await request(app)
      .patch('/api/v1/me')
      .set(auth)
      .send({ specialties: ['cardiology', 'internalMedicine', 'cardiology'] })
      .expect(200);
    expect(set.body.data.specialties).toEqual(['cardiology', 'internalMedicine']);
    expect((await meOf(doctor)).specialties).toEqual(['cardiology', 'internalMedicine']);

    // Other changes leave them be.
    await request(app).patch('/api/v1/me').set(auth).send({ name: 'Dr Renamed' }).expect(200);
    expect((await meOf(doctor)).specialties).toEqual(['cardiology', 'internalMedicine']);

    const refused = await request(app)
      .patch('/api/v1/me')
      .set(auth)
      .send({ specialties: ['astrology'] })
      .expect(400);
    expect(refused.body.error.code).toBe('VALIDATION_ERROR');

    await request(app).patch('/api/v1/me').set(auth).send({ specialties: [] }).expect(200);
    expect((await meOf(doctor)).specialties).toEqual([]);

    // On the person, in every clinic's audit trail they work in.
    const entries = await AuditLog.find({ action: 'user.update', practiceId: doctor.practiceId }).sort({ _id: 1 });
    expect(entries.map((entry) => entry.after)).toEqual([
      { name: 'Dr Ayesha', specialties: ['cardiology', 'internalMedicine'] },
      { name: 'Dr Renamed', specialties: ['cardiology', 'internalMedicine'] },
      { name: 'Dr Renamed', specialties: [] },
    ]);
  });

  test("a location's province and city round-trip through the location routes, the city in title case", async () => {
    const { doctor } = await aClinic('+923001110031');
    const headers = headersFor(doctor);

    const first = (await request(app).get('/api/v1/locations').set(headers).expect(200)).body.data[0];
    expect(first).toMatchObject({ province: null, city: null });

    const created = await request(app)
      .post('/api/v1/locations')
      .set(headers)
      .send({ name: 'Gulberg', address: 'Main Boulevard', province: 'punjab', city: '  lahore ' })
      .expect(201);
    const { id } = created.body.data;
    expect(created.body.data).toMatchObject({ province: 'punjab', city: 'Lahore' });

    const moved = await request(app)
      .patch(`/api/v1/locations/${id}`)
      .set(headers)
      .send({ province: 'khyberPakhtunkhwa', city: 'DERA   ismail khan' })
      .expect(200);
    expect(moved.body.data).toMatchObject({ province: 'khyberPakhtunkhwa', city: 'Dera Ismail Khan' });
    expect((await Location.findById(id))!.city).toBe('Dera Ismail Khan');

    // A patch names only what it changes: the rest stays.
    const renamed = await request(app)
      .patch(`/api/v1/locations/${id}`)
      .set(headers)
      .send({ name: 'Gulberg II' })
      .expect(200);
    expect(renamed.body.data).toMatchObject({
      name: 'Gulberg II',
      address: 'Main Boulevard',
      province: 'khyberPakhtunkhwa',
      city: 'Dera Ismail Khan',
    });

    const listed = (await request(app).get('/api/v1/locations').set(headers).expect(200)).body.data;
    expect(listed.find((location: { id: string }) => location.id === id)).toMatchObject({
      province: 'khyberPakhtunkhwa',
      city: 'Dera Ismail Khan',
    });

    const cleared = await request(app)
      .patch(`/api/v1/locations/${id}`)
      .set(headers)
      .send({ province: null, city: '' })
      .expect(200);
    expect(cleared.body.data).toMatchObject({ province: null, city: null });

    const label = await request(app).patch(`/api/v1/locations/${id}`).set(headers).send({ province: 'Punjab' }).expect(400);
    expect(label.body.error.code).toBe('VALIDATION_ERROR');
  });
});
