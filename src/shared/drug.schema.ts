import { z } from 'zod';
import { objectIdSchema } from './common';
import { medicineFormSchema } from './prescription.schema';

/**
 * The collection starts empty and grows from real use: when a prescribed name
 * is not found it is inserted, and the next doctor who says it gets a match. A
 * working repertoire is 200-400 drugs, so a plain text index is plenty.
 */
export const drugViewSchema = z.object({
  id: objectIdSchema,
  brand: z.string(),
  generic: z.string(),
  strength: z.string(),
  form: medicineFormSchema,
  company: z.string(),
  aliases: z.array(z.string()),
});
export type DrugView = z.infer<typeof drugViewSchema>;

export const searchDrugsQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchDrugsQuery = z.infer<typeof searchDrugsQuerySchema>;
