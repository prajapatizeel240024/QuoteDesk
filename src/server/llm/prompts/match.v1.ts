import type { Config } from '@/lib/config';
import type { MatchItem } from '@/lib/types';

export const VERSION = 'match.v1';

export function system(cfg: Config): string {
  return [
    `You match lines from customers' requests for quote to parts in the catalog of ${cfg.distributor.name}, an industrial parts distributor.`,
    '',
    'Each item has the request text and up to 5 candidate parts from the catalog. Pick the candidate that is exactly what the customer asked for, or NONE.',
    '',
    'For each item, return:',
    '- line_ref: the item ref.',
    '- sku: one of its candidate SKUs, or NONE.',
    '- confidence: 0 to 1.',
    '- evidence: one to three short quotes copied character for character from the request text. Never quote the catalog.',
    '- why: one short sentence.',
    '',
    'Rules:',
    '- Use 0.9 or more only when size, thread, material, grade, finish and type all agree with the request and rule out the other candidates.',
    '- When the request leaves out something that separates the candidates (sealed or shielded, grade 5 or grade 8), pick the most likely one with confidence below 0.6.',
    '- A part number with one wrong character is fine when the description agrees with the candidate.',
    '- Trade words are fine: a hex bolt is a hex cap screw, a prox is a proximity sensor.',
    '- If no candidate fits, return NONE. Never write prices.',
  ].join('\n');
}

export function user(items: MatchItem[]): string {
  return JSON.stringify({ items: items.map((i) => ({ line_ref: i.ref, request: i.request, candidates: i.candidates.map((c) => ({ sku: c.sku, description: c.description, mfr_part: c.mfr_part })) })) }, null, 1);
}

export function schema(items: MatchItem[]): Record<string, unknown> {
  const skus = [...new Set(items.flatMap((i) => i.candidates.map((c) => c.sku)))].sort();
  return {
    type: 'object',
    additionalProperties: false,
    required: ['matches'],
    properties: {
      matches: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['line_ref', 'sku', 'confidence', 'evidence', 'why'],
          properties: { line_ref: { type: 'string' }, sku: { type: 'string', enum: [...skus, 'NONE'] }, confidence: { type: 'number' }, evidence: { type: 'array', items: { type: 'string' } }, why: { type: 'string' } },
        },
      },
    },
  };
}
