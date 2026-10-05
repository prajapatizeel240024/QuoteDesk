// zod schemas: Claude's structured outputs (checked again after the API enforces the JSON schema) and API bodies.
import { z } from 'zod';

export const ExtractOutputZ = z.object({
  items: z.array(z.object({ block_ref: z.string(), quote: z.string(), part_text: z.string(), description: z.string(), qty_text: z.string(), uom_text: z.string(), due_text: z.string(), certs_text: z.string() })),
  defaults: z.object({ quote: z.string(), due_text: z.string(), certs_text: z.string() }),
});

export const MatchOutputZ = z.object({
  matches: z.array(z.object({ line_ref: z.string(), sku: z.string(), confidence: z.number().min(0).max(1), evidence: z.array(z.string()).max(5), why: z.string() })),
});

export const QuestionOutputZ = z.object({ subject: z.string().min(3).max(200), body: z.string().min(20).max(3000) });

const Version = z.number().int().positive();
const Sku = z.string().regex(/^AF-\d{5}$/, 'A catalog SKU looks like AF-10117.');
const Reason = z.string().trim().min(3, 'Give a short reason.').max(300);

export const LoadRfqBody = z.strictObject({ fixture_id: z.string().regex(/^rfq-\d{2}$/) });
export const PatchLineBody = z.strictObject({
  version: Version,
  part_sku: Sku.optional(),
  qty: z.number().int().positive().max(1_000_000).optional(),
  uom: z.enum(['EA', 'FT', 'PK']).optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  certs: z.array(z.enum(['CoC', 'MTR', 'RoHS', 'REACH', 'FAI'])).max(5).optional(),
  price_override_cents: z.number().int().positive().max(100_000_000).nullable().optional(),
  price_override_reason: Reason.optional(),
});
export const ApproveBody = z.strictObject({ version: Version, override_reason: Reason.optional() });
export const RejectBody = z.strictObject({ version: Version, reason: Reason });
export const ReopenBody = z.strictObject({ version: Version });
export const ResolveBody = z.union([z.strictObject({ version: Version, part_sku: Sku }), z.strictObject({ version: Version, not_carried: z.literal(true) })]);
export const ClearExportBody = z.strictObject({ version: Version, reviewer: z.string().trim().min(2).max(80), reason: Reason });
export const QuestionPatchBody = z.strictObject({ version: Version, subject: z.string().trim().min(3).max(200).optional(), body: z.string().trim().min(10).max(3000).optional(), status: z.literal('sent').optional() });
