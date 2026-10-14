import { idParamSchema } from '../shared/common';
import { recordVitalsBodySchema } from '../shared/vitals.schema';

export const getVitals = { params: idParamSchema };
export const recordVitals = { params: idParamSchema, body: recordVitalsBodySchema };
