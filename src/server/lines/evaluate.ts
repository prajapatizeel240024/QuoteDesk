// Prices a line and raises its flags from its current state. Pure: the pipeline uses it before a line is
// saved, and the lines service uses it after every change, so both always agree.
import type { Cert, CustomerRules, ExportHold, Flag, MatchStatus, MissingField, Part, PriceResult, PricingRules, Requested, Tier, Uom } from '@/lib/types';
import { checkLine } from '@/server/checks/rules';
import { priceLine, unitsFor } from '@/server/pricing/engine';

export interface LineState {
  requested: Requested;
  qty: number | null;
  uom: Uom;
  due_date: string | null;
  certs: Cert[];
  certs_unclear: boolean;
  part_sku: string | null;
  requested_sku: string | null;
  match_status: MatchStatus;
  claude_said_none: boolean;
  export_hold: ExportHold | null;
  export_term: string | null;
  export_cleared: { by: string; reason: string } | null;
  price_override_cents: number | null;
  price_override_reason: string | null;
}

export interface EvalContext {
  parts: Map<string, Part>;
  tier: Tier;
  rules: PricingRules;
  customerRules: CustomerRules;
  holidays: readonly string[];
  quote_date: string;
}

export function missingOf(s: Pick<LineState, 'qty' | 'due_date' | 'certs_unclear'>): MissingField[] {
  return [...(s.qty === null ? (['qty'] as const) : []), ...(s.due_date === null ? (['due_date'] as const) : []), ...(s.certs_unclear ? (['cert_type'] as const) : [])];
}

export function evaluateLine(s: LineState, ctx: EvalContext): { price: PriceResult | null; flags: Flag[]; missing: MissingField[]; unit_note: string | null } {
  const part = s.part_sku ? ctx.parts.get(s.part_sku) ?? null : null;
  const requestedPart = s.requested_sku ? ctx.parts.get(s.requested_sku) ?? null : null;
  const replacement = part?.status === 'obsolete' && part.superseded_by ? ctx.parts.get(part.superseded_by) ?? null : null;
  const held = Boolean(s.export_hold && !s.export_cleared);
  const missing = missingOf(s);
  let price: PriceResult | null = null;
  let unitNote: string | null = null;
  if (part && part.status === 'active' && s.qty !== null && !held) {
    const u = unitsFor(s.qty, s.uom, part);
    unitNote = u.note;
    price = priceLine(
      { cost_cents: part.cost_cents, qty: u.units, pack_qty: part.pack_qty, tier: ctx.tier, quote_date: ctx.quote_date, due_date: s.due_date, stock_qty: part.stock_qty, lead_time_days: part.lead_time_days, rush_fee_waived: ctx.customerRules.rush_fee_waived, override_unit_cents: s.price_override_cents },
      ctx.rules,
      ctx.holidays,
    );
  }
  const flags = checkLine(
    {
      requested: s.requested,
      qty: s.qty,
      certs: s.certs,
      certs_unclear: s.certs_unclear,
      missing,
      match_status: s.match_status,
      part,
      requested_part: requestedPart,
      replacement,
      claude_said_none: s.claude_said_none,
      export_hold: s.export_hold,
      export_term: s.export_term,
      export_cleared: s.export_cleared,
      price,
      override: s.price_override_cents ? { unit_cents: s.price_override_cents, reason: s.price_override_reason ?? '' } : null,
    },
    { floor_margin_bps: ctx.rules.floor_margin_bps, min_line_cents: ctx.rules.min_line_cents },
  );
  return { price, flags, missing, unit_note: unitNote };
}
