import type { Config } from '@/lib/config';
import type { MissingField, QuestionRequest } from '@/lib/types';

export const VERSION = 'question.v1';

export function system(cfg: Config): string {
  const rep = cfg.distributor.rep;
  return [
    `You write a short email from ${rep.name}, ${rep.title.toLowerCase()} at ${cfg.distributor.name}, to a buyer who sent a request for quote. The email asks only for the missing details listed.`,
    '',
    'Rules:',
    '- Refer to each line as "Line N" and repeat the buyer\'s own words for it in quotes.',
    '- Ask one clear question for each missing detail. Ask for nothing else.',
    '- No prices, no stock or delivery promises, no internal reasons.',
    `- Plain text, friendly and short: under 140 words. Sign with "${rep.name.split(' ')[0]}".`,
    '- subject: "Re: " and the RFQ subject, then a few words.',
  ].join('\n');
}

const WORDS: Record<MissingField, string> = { qty: 'quantity', due_date: 'need-by date', cert_type: 'which certificates' };

export function user(req: QuestionRequest): string {
  return JSON.stringify({ buyer_first_name: req.buyer_first_name, rfq_subject: req.rfq_subject, missing: req.asks.map((a) => ({ line: `Line ${a.line_no}`, buyer_words: a.buyer_words, missing: a.fields.map((f) => WORDS[f]) })) }, null, 1);
}

export const SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: { subject: { type: 'string' }, body: { type: 'string' } },
};
