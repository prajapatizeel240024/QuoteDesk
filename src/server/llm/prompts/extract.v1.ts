import type { Config } from '@/lib/config';
import type { ExtractRequest } from '@/lib/types';
import { REDACTED } from '@/server/extract/text';

export const VERSION = 'extract.v1';

export function system(cfg: Config): string {
  return [
    `You read requests for quote (RFQs) emailed to ${cfg.distributor.name}, an industrial parts distributor, and pull out the items the customer wants priced.`,
    '',
    'You get parts of one email as blocks, each with a ref. Items the rules already found are listed in already_found; never return those again.',
    '',
    'For each item the customer wants priced, return:',
    '- block_ref: the ref of the block the item is in.',
    '- quote: the shortest span of that block holding the whole item, copied character for character.',
    '- part_text: a part number exactly as written, or "".',
    '- description: the words that describe the item, copied exactly, or "".',
    '- qty_text: the quantity exactly as written ("40", "a box", "1.5k"), or "".',
    '- uom_text: a unit written next to the quantity ("ft", "pcs"), or "".',
    '- due_text: a need-by date written for this item only, or "".',
    '- certs_text: certificates asked for on this item only, or "".',
    '',
    'Also return defaults: a need-by date or certificates the email applies to every item ("Need everything by Oct 20"), with quote copied exactly. Use "" when there are none.',
    '',
    'Rules:',
    '- Copy, never convert: write "a box", not 1; write "Friday the 16th", not a date.',
    '- Every non-empty field must appear inside its quote.',
    '- Skip greetings, signatures, and anything the customer says they do not need.',
    `- Text shown as "${REDACTED}" was removed on purpose. Never guess what it said and never return it.`,
    '- Never invent part numbers, quantities or dates, and never write prices.',
  ].join('\n');
}

export function user(req: ExtractRequest): string {
  return JSON.stringify({ from: req.from, subject: req.subject, already_found: req.already_found, blocks: req.blocks.map((b) => ({ ref: b.ref, text: b.text })) }, null, 1);
}

const str = { type: 'string' };
export const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'defaults'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['block_ref', 'quote', 'part_text', 'description', 'qty_text', 'uom_text', 'due_text', 'certs_text'],
        properties: { block_ref: str, quote: str, part_text: str, description: str, qty_text: str, uom_text: str, due_text: str, certs_text: str },
      },
    },
    defaults: { type: 'object', additionalProperties: false, required: ['quote', 'due_text', 'certs_text'], properties: { quote: str, due_text: str, certs_text: str } },
  },
};
