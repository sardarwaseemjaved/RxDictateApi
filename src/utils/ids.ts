import { randomBytes } from 'crypto';

/**
 * The id of one item inside a prescription section.
 *
 * Not an ObjectId: these are not documents, they are list entries that ops
 * address by id, and they travel through an LLM's output where a short opaque
 * token is easier to keep intact.
 */
export const newItemId = (): string => randomBytes(6).toString('hex');

/** The id of one transcript span. Same reasoning. */
export const newSpanId = (): string => randomBytes(6).toString('hex');
