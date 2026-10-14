import { createPracticeBodySchema } from '../shared/auth.schema';
import { updatePracticeBodySchema } from '../shared/practice.schema';

export const updatePractice = { body: updatePracticeBodySchema };

export const createMyPractice = { body: createPracticeBodySchema };
