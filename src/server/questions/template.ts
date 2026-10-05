// The plain-text fallback for the question to the buyer. Used when Claude isn't available or its draft
// fails the checks, and by the oracle stand-in.
import type { MissingField, QuestionOutput, QuestionRequest } from '@/lib/types';

const ASK: Record<MissingField, string> = {
  qty: 'what quantity do you need?',
  due_date: 'what date do you need it by?',
  cert_type: 'which certificates do you need (for example a certificate of conformance or a material test report)?',
};

export function templateQuestion(req: QuestionRequest): QuestionOutput {
  const lines = req.asks.map((a) => `- Line ${a.line_no} ("${a.buyer_words}"): ${a.fields.map((f) => ASK[f]).join(' Also, ')}`);
  return {
    subject: `Re: ${req.rfq_subject} - a few details before we quote`,
    body: [`Hi ${req.buyer_first_name},`, '', 'Thanks for the request. Before we finish the quote, could you confirm a few details?', '', ...lines, '', "We'll send the full quote as soon as we hear back.", '', 'Thanks,', req.rep_first_name].join('\n'),
  };
}
