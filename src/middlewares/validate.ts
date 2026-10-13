import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../core/errors';
import pick from '../utils/pick';

export interface RequestSchema {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

const PARTS = ['params', 'query', 'body'] as const;

/**
 * The same middleware pattern as before, with zod inside instead of Joi.
 *
 * The parsed value replaces the raw one, so a handler reads coerced,
 * defaulted, unknown-key-stripped input and nothing else. Every failure comes
 * back as one VALIDATION_ERROR carrying a field-by-field list, because a form
 * wants all of its errors at once.
 */
const validate =
  (schema: RequestSchema): RequestHandler =>
  (req, res, next) => {
    const validSchema = pick(schema, PARTS);
    const details: { field: string; message: string }[] = [];

    PARTS.forEach((part) => {
      const partSchema = validSchema[part];
      if (!partSchema) return;

      const result = partSchema.safeParse(req[part]);
      if (!result.success) {
        result.error.issues.forEach((issue) => {
          details.push({
            field: [part, ...issue.path.map(String)].filter(Boolean).join('.'),
            message: issue.message,
          });
        });
        return;
      }
      // eslint-disable-next-line no-param-reassign
      req[part] = result.data as never;
    });

    if (details.length > 0) {
      return next(new AppError('VALIDATION_ERROR', details.map((d) => `${d.field}: ${d.message}`).join(', '), details));
    }
    return next();
  };

export default validate;
