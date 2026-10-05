// The quote email: the quoting version of TimeDraft's LEDES export. Built entirely by code from approved
// lines, so every number in it comes from the pricing engine. Plain text, readable in any email client.
import type { Pool } from 'pg';
import { certLabel, customerById, customerRules, loadConfig } from '@/lib/config';
import { addDays } from '@/lib/dates';
import { longDate, money, shortDate } from '@/lib/format';
import type { Cert } from '@/lib/types';
import { withTx } from '@/server/db';
import { audit } from '@/server/lines/audit';
import { getLineViews, HttpError, type LineView } from '@/server/lines/service';
import { compact } from '@/server/match/normalize';

export interface QuoteInput {
  quote_number: string;
  rfq_subject: string;
  buyer_first_name: string;
  valid_until: string;
  terms: string;
  rep: { name: string; title: string; email: string };
  distributor: { name: string; phone: string };
  lines: LineView[];
}

/** What the customer reads for a line we didn't quote. Internal reasons never leak into the email. */
export function notQuotedNote(l: LineView): string {
  if (l.export_hold && !l.export_cleared) return 'We need to review this item before we can quote it, and will follow up separately.';
  if (l.not_carried) return "We don't carry this item.";
  if (l.part?.status === 'obsolete') return 'This part is discontinued.';
  if (l.missing.includes('qty')) return 'We need the quantity before we can quote this line.';
  return 'Not quoted this time.';
}

function lineBlock(l: LineView, n: number): string[] {
  const p = l.price!;
  const part = l.part!;
  const out = [`${n}. ${part.sku}  ${part.description}`];
  const theirs = l.requested.part_text && !l.requested_part && ![compact(part.sku), compact(part.mfr_part)].includes(compact(l.requested.part_text)) ? `Your part ${l.requested.part_text}. ` : '';
  const pack = p.pack_rounded ? ` (sold in packs of ${p.pack_qty}; you asked for ${p.qty})` : '';
  out.push(`   ${theirs}${p.billed_qty.toLocaleString('en-US')} ${part.uom} at ${money(p.unit_cents)} each = ${money(p.extended_cents)}${pack}`);
  if (l.requested_part) out.push(`   Replaces ${l.requested_part.sku} (${l.requested_part.mfr_part}), which is discontinued.`);
  let when = p.rush ? `Ships rush to arrive by ${shortDate(p.arrive_date)}${p.rush_fee_cents ? `, rush fee ${money(p.rush_fee_cents)}` : ''}.` : p.partial ? `${p.partial.qty.toLocaleString('en-US')} can arrive by ${shortDate(p.partial.arrive_date)} and the rest by ${shortDate(p.arrive_date)}.` : `Arrives by ${shortDate(p.arrive_date)}.`;
  if (p.misses_due && p.due_date) when += ` You asked for ${shortDate(p.due_date)}.`;
  out.push(`   ${when}`);
  if (p.min_line_adjust_cents) out.push(`   Includes a ${money(p.min_line_adjust_cents)} minimum line charge.`);
  const certs = l.certs.filter((c) => part.certs.includes(c));
  const missing = l.certs.filter((c) => !part.certs.includes(c));
  if (certs.length) out.push(`   Includes: ${certs.map((c) => certLabel(c as Cert)).join(', ')}.`);
  if (missing.length) out.push(`   Not available for this part: ${missing.map((c) => certLabel(c as Cert)).join(', ')}.`);
  return out;
}

export function buildQuoteEmail(q: QuoteInput): { subject: string; text: string; total_cents: number } {
  const quoted = q.lines.filter((l) => l.status === 'approved' && l.price && l.part);
  const notQuoted = q.lines.filter((l) => l.status === 'rejected' || (l.status === 'approved' && !l.price));
  const subtotal = quoted.reduce((s, l) => s + l.price!.extended_cents + l.price!.min_line_adjust_cents, 0);
  const rush = quoted.reduce((s, l) => s + l.price!.rush_fee_cents, 0);
  const total = subtotal + rush;
  const text = [
    `Hi ${q.buyer_first_name},`,
    '',
    'Thanks for your request. Our quote is below.',
    '',
    ...quoted.flatMap((l, i) => [...lineBlock(l, i + 1), '']),
    `Subtotal: ${money(subtotal)}`,
    ...(rush ? [`Rush fees: ${money(rush)}`] : []),
    `Total: ${money(total)}`,
    '',
    ...(notQuoted.length ? ['Not quoted:', ...notQuoted.map((l) => `- Your line ${l.line_no} (${[l.requested.part_text, l.requested.description].filter(Boolean).join(', ')}): ${notQuotedNote(l)}`), ''] : []),
    `Prices are in US dollars and good through ${longDate(q.valid_until)}. Terms: ${q.terms}.`,
    '',
    'Best regards,',
    q.rep.name,
    `${q.rep.title}, ${q.distributor.name}`,
    `${q.distributor.phone} | ${q.rep.email}`,
  ].join('\n');
  return { subject: `Quote ${q.quote_number}: ${q.rfq_subject}`, text: text + '\n', total_cents: total };
}

export async function generateQuote(pool: Pool, rfqId: string, actor: string): Promise<{ quote_number: string; subject: string; text: string; total_cents: number }> {
  const rfq = await pool.query<{ customer_id: string; subject: string; from_name: string; quote_date: string }>('select customer_id, subject, from_name, quote_date from rfqs where id = $1', [rfqId]);
  if (!rfq.rowCount) throw new HttpError(404, 'That RFQ has not been loaded.');
  const r = rfq.rows[0];
  const lines = await getLineViews(pool, { rfqId });
  const undecided = lines.filter((l) => l.status === 'draft');
  if (undecided.length) throw new HttpError(409, `${undecided.length === 1 ? 'Line' : 'Lines'} ${undecided.map((l) => l.line_no).join(', ')} still ${undecided.length === 1 ? 'needs' : 'need'} a decision. Approve or reject every line first.`);
  if (!lines.some((l) => l.status === 'approved' && l.price)) throw new HttpError(422, 'Approve at least one priced line before generating the quote.');
  const cfg = loadConfig();
  const customer = customerById(r.customer_id, cfg);
  const validDays = customerRules(customer).quote_valid_days ?? cfg.pricing.quote_valid_days;
  return withTx(pool, async (c) => {
    const base = `Q-${customer.id.slice(2)}-${r.quote_date.replace(/-/g, '')}`;
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [base]);
    const taken = await c.query<{ n: number }>('select count(*)::int as n from quotes where quote_number like $1', [`${base}%`]);
    const quoteNumber = taken.rows[0].n ? `${base}-${taken.rows[0].n + 1}` : base;
    const email = buildQuoteEmail({ quote_number: quoteNumber, rfq_subject: r.subject, buyer_first_name: r.from_name.split(' ')[0], valid_until: addDays(r.quote_date, validDays), terms: customer.terms, rep: cfg.distributor.rep, distributor: cfg.distributor, lines });
    const ins = await c.query<{ id: string }>(
      'insert into quotes (rfq_id, quote_number, line_ids, total_cents, email_subject, email_text) values ($1,$2,$3,$4,$5,$6) returning id',
      [rfqId, quoteNumber, lines.filter((l) => l.status === 'approved').map((l) => l.id), email.total_cents, email.subject, email.text],
    );
    await c.query(`update rfqs set status = 'quoted' where id = $1`, [rfqId]);
    await audit(c, { subject_type: 'quote', subject_id: ins.rows[0].id, actor, action: 'generated', after: { quote_number: quoteNumber, total_cents: email.total_cents, lines: lines.filter((l) => l.status === 'approved').length, not_quoted: lines.filter((l) => l.status === 'rejected').map((l) => l.line_no) } });
    return { quote_number: quoteNumber, subject: email.subject, text: email.text, total_cents: email.total_cents };
  });
}
