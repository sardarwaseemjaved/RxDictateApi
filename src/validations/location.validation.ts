import { idParamSchema } from '../shared/common';
import { createLocationBodySchema, listLocationsQuerySchema, updateLocationBodySchema } from '../shared/location.schema';

export const listLocations = { query: listLocationsQuerySchema };
export const createLocation = { body: createLocationBodySchema };
export const updateLocation = { params: idParamSchema, body: updateLocationBodySchema };
export const archiveLocation = { params: idParamSchema };
