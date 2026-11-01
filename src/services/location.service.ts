import { Types } from 'mongoose';
import { Location, type ILocation, type LocationDoc } from '../models';
import { BaseRepository, type Scope } from '../core/db';
import { AppError } from '../core/errors';
import { writeAudit } from '../core/audit';
import { emit } from '../core/events';
import type { CreateLocationBody, ListLocationsQuery, LocationView, UpdateLocationBody } from '../shared/location.schema';

const locations = new BaseRepository<ILocation>(Location);

export const toLocationView = (location: LocationDoc): LocationView => ({
  id: String(location._id),
  name: location.name,
  address: location.address,
  phone: location.phone,
  timings: location.timings,
  letterhead: location.letterhead,
  isDefault: location.isDefault,
  status: location.status,
});

export const listLocations = async (scope: Scope, query: ListLocationsQuery): Promise<LocationView[]> => {
  const found = await locations.find(scope, query.status ? { status: query.status } : {}, {
    sort: { isDefault: -1, name: 1 },
  });
  return found.map(toLocationView);
};

/** Only one location is the default, so setting a new one clears the old. */
const clearOtherDefaults = async (scope: Scope, keep: Types.ObjectId): Promise<void> => {
  await Location.updateMany(locations.scopedFilter(scope, { _id: { $ne: keep }, isDefault: true }), {
    $set: { isDefault: false },
  });
};

export const createLocation = async (scope: Scope, body: CreateLocationBody): Promise<LocationView> => {
  // The first location of a practice is the default whether or not the caller
  // said so, because a prescription has to print on something.
  const existing = await locations.count(scope);
  const isDefault = body.isDefault || existing === 0;

  const location = await locations.create(scope, { ...body, isDefault, status: 'active' });
  if (isDefault) {
    await clearOtherDefaults(scope, location._id);
  }

  await writeAudit(scope, {
    action: 'location.create',
    entity: 'location',
    entityId: location._id,
    locationId: location._id,
    after: toLocationView(location),
  });
  emit('location.added', { practiceId: scope.practiceId, locationId: location._id, actorId: scope.actorId });

  return toLocationView(location);
};

export const updateLocation = async (scope: Scope, id: string, patch: UpdateLocationBody): Promise<LocationView> => {
  const location = await locations.findByIdOrFail(scope, id, 'Location');
  const before = toLocationView(location);

  if (patch.name !== undefined) location.name = patch.name;
  if (patch.address !== undefined) location.address = patch.address;
  if (patch.phone !== undefined) location.phone = patch.phone;
  if (patch.timings !== undefined) location.timings = patch.timings;
  if (patch.letterhead !== undefined) location.letterhead = patch.letterhead;
  if (patch.isDefault !== undefined) location.isDefault = patch.isDefault;

  await location.save();
  if (location.isDefault) {
    await clearOtherDefaults(scope, location._id);
  }

  const after = toLocationView(location);
  await writeAudit(scope, {
    action: 'location.update',
    entity: 'location',
    entityId: location._id,
    locationId: location._id,
    before,
    after,
  });
  emit('location.updated', { practiceId: scope.practiceId, locationId: location._id, actorId: scope.actorId });

  // An address change must not reach a prescription that has already been
  // printed; that is what the letterhead snapshot on an approved prescription
  // is for, and nothing here touches it.
  return after;
};

/**
 * Archived, never deleted. Prescriptions point at a location and their
 * letterhead snapshot has to stay explicable, so the row stays and only its
 * status changes.
 */
export const archiveLocation = async (scope: Scope, id: string): Promise<LocationView> => {
  const location = await locations.findByIdOrFail(scope, id, 'Location');
  if (location.status === 'archived') {
    return toLocationView(location);
  }

  const active = await locations.count(scope, { status: 'active' });
  if (active <= 1) {
    throw new AppError('CONFLICT', 'A clinic needs at least one active location.');
  }

  const before = toLocationView(location);
  location.status = 'archived';
  location.isDefault = false;
  await location.save();

  // If the archived one was the default, something else has to be.
  const remainingDefault = await locations.count(scope, { status: 'active', isDefault: true });
  if (remainingDefault === 0) {
    const next = await locations.findOne(scope, { status: 'active' });
    if (next) {
      next.isDefault = true;
      await next.save();
    }
  }

  const after = toLocationView(location);
  await writeAudit(scope, {
    action: 'location.archive',
    entity: 'location',
    entityId: location._id,
    locationId: location._id,
    before,
    after,
  });
  emit('location.archived', { practiceId: scope.practiceId, locationId: location._id, actorId: scope.actorId });

  return after;
};

export default { listLocations, createLocation, updateLocation, archiveLocation, toLocationView };
