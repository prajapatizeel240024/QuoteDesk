// Pricing and lead-time rules, the quoting version of TimeDraft's billing-guideline checks. Pure and
// client-safe: the review screen runs the same checks while the rep edits a line.
import { money, pct, shortDate } from '@/lib/format';
import type { Cert, ExportHold, Flag, MatchStatus, MissingField, Part, PriceResult, Requested } from '@/lib/types';

export interface LineFacts {
  requested: Requested;
  qty: number | null;
  certs: Cert[];
  certs_unclear: boolean;
  missing: MissingField[];
  match_status: MatchStatus;
  part: Part | null;
  requested_part: Part | null; // the obsolete part the buyer asked for, when a replacement is quoted
  replacement: Part | null; // what the ERP lists as the obsolete part's replacement
  claude_said_none: boolean;
  export_hold: ExportHold | null;
  export_term: string | null;
  export_cleared: { by: string; reason: string } | null;
  price: PriceResult | null;
  override: { unit_cents: number; reason: string } | null;
}

export interface CheckContext {
  floor_margin_bps: number;
  min_line_cents: number;
}

const FIELD_TEXT: Record<MissingField, (r: Requested) => string> = {
  qty: (r) => `No usable quantity (${r.qty_text ? `"${r.qty_text}"` : 'left blank'}).`,
  due_date: (r) => `No firm need-by date (${r.due_text ? `"${r.due_text}"` : 'left blank'}).`,
  cert_type: (r) => `Asks for certs without saying which ("${r.certs_text}").`,
};

export function checkLine(f: LineFacts, ctx: CheckContext): Flag[] {
  const flags: Flag[] = [];
  const held = Boolean(f.export_hold && !f.export_cleared);
  if (f.export_hold) {
    if (f.export_cleared) {
      flags.push({ code: 'EXPORT_CONTROLLED', severity: 'info', message: `Export review cleared by ${f.export_cleared.by}: ${f.export_cleared.reason}`, evidence: [f.export_hold] });
    } else {
      const why =
        f.export_hold === 'marked'
          ? 'The buyer marked this line export-controlled.'
          : f.export_hold === 'screened'
            ? `It mentions "${f.export_term}", which is on the export screening list.`
            : `${f.part?.sku ?? 'This part'} is flagged export-controlled in the ERP.`;
      flags.push({ code: 'EXPORT_CONTROLLED', severity: 'block', message: `${why} Held for a person to review: no price until it's cleared, and the line is never sent to Claude.`, evidence: [f.export_hold, ...(f.export_term ? [f.export_term] : [])] });
    }
  }
  if (!held && !f.part && f.match_status === 'needs_review') {
    flags.push({
      code: 'UNKNOWN_PART',
      severity: 'block',
      message: f.claude_said_none ? 'Claude found no catalog part that fits. Pick one, or mark the line as not carried.' : 'No catalog part matched with enough confidence. Pick one, or mark the line as not carried.',
      evidence: [f.requested.part_text || f.requested.description],
    });
  }
  if (!held && f.part?.status === 'obsolete') {
    flags.push({
      code: 'OBSOLETE_PART',
      severity: 'block',
      message: `${f.part.sku} is obsolete in the ERP.${f.replacement ? ` Its listed replacement is ${f.replacement.sku}, ${f.replacement.description}.` : ' No replacement is listed.'}`,
      evidence: f.replacement ? [f.part.sku, f.replacement.sku] : [f.part.sku],
    });
  }
  if (f.requested_part && f.part && f.requested_part.sku !== f.part.sku) {
    flags.push({ code: 'SUBSTITUTED', severity: 'warn', message: `The buyer asked for ${f.requested_part.sku}, which is obsolete. The line quotes its replacement, ${f.part.sku}, and the quote email says so.`, evidence: [f.requested_part.sku, f.part.sku] });
  }
  const missing = [...f.missing];
  if (missing.length) {
    const severity = missing.includes('qty') || missing.includes('cert_type') ? 'block' : 'warn';
    flags.push({ code: 'MISSING_INFO', severity, message: missing.map((m) => FIELD_TEXT[m](f.requested)).join(' ') + ' A question for the buyer is drafted below.', evidence: missing });
  }
  if (!held && f.part && f.certs.length) {
    const unavailable = f.certs.filter((c) => !f.part!.certs.includes(c));
    if (unavailable.length) {
      flags.push({ code: 'CERT_UNAVAILABLE', severity: 'warn', message: `${unavailable.join(' and ')} isn't available for ${f.part.sku}. ${f.part.mfr} offers ${f.part.certs.join(', ') || 'no certs'}.`, evidence: unavailable });
    }
  }
  const p = f.price;
  if (p) {
    if (p.pack_rounded) flags.push({ code: 'PACK_ROUNDED', severity: 'warn', message: `Sold in packs of ${p.pack_qty}, so ${p.billed_qty} are quoted for the ${p.qty} requested.`, evidence: [String(p.qty), String(p.billed_qty)] });
    if (p.misses_due && p.due_date) {
      const part = p.partial ? ` ${p.partial.qty} in stock could arrive by ${shortDate(p.partial.arrive_date)}.` : '';
      flags.push({ code: 'LEAD_TIME_MISS', severity: 'warn', message: `Arrives ${shortDate(p.arrive_date)}, but the buyer needs it by ${shortDate(p.due_date)}.${part}`, evidence: [p.arrive_date, p.due_date] });
    }
    if (!p.in_stock) {
      const msg = p.stock_qty > 0 ? `${p.stock_qty} in stock; the rest ship ${p.lead_time_days} business days after the order.` : `None in stock; ships ${p.lead_time_days} business days after the order.`;
      flags.push({ code: 'STOCK_SHORT', severity: 'info', message: msg, evidence: [String(p.stock_qty), String(p.billed_qty)] });
    }
    if (p.rush && p.due_date) {
      flags.push({ code: 'RUSH_FEE', severity: 'info', message: p.rush_fee_waived ? `Ships rush to arrive by ${shortDate(p.due_date)}. This customer's rush fees are waived.` : `Ships rush to arrive by ${shortDate(p.due_date)}, with a ${money(p.rush_fee_cents)} rush fee.`, evidence: [String(p.rush_fee_cents)] });
    }
    if (p.min_line_adjust_cents > 0) flags.push({ code: 'MIN_LINE', severity: 'info', message: `Under the ${money(ctx.min_line_cents)} minimum line charge, so ${money(p.min_line_adjust_cents)} is added.`, evidence: [String(p.min_line_adjust_cents)] });
    if (p.overridden && f.override) {
      flags.push({ code: 'PRICE_OVERRIDE', severity: 'warn', message: `Unit price set by hand to ${money(p.unit_cents)} (list ${money(p.list_unit_cents)}): ${f.override.reason}`, evidence: [String(p.unit_cents), String(p.list_unit_cents)] });
      if (p.actual_margin_bps < ctx.floor_margin_bps) {
        flags.push({ code: 'BELOW_FLOOR', severity: 'block', message: `That's a ${pct(p.actual_margin_bps)} margin, under the ${pct(ctx.floor_margin_bps)} floor.`, evidence: [String(p.actual_margin_bps)] });
      }
    }
  }
  return flags;
}
