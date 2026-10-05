// Every price QuoteDesk shows comes from here: integer cents, deterministic, no model involved.
// Pure and client-safe, so the review screen previews an edit with the same code the server saves.
import { addBusinessDays } from '@/lib/dates';
import type { Part, PriceInput, PriceResult, PricingRules, Tier, Uom } from '@/lib/types';

/** ceil(a / b) for non-negative integers, without floating point. */
export function ceilDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b <= 0) throw new Error(`ceilDiv needs whole numbers, got ${a} / ${b}`);
  return Math.floor((a + b - 1) / b);
}

/** Quantity rounded up to whole packs. */
export function billedQty(qty: number, packQty: number): number {
  return ceilDiv(qty, packQty) * packQty;
}

export function marginFor(rules: PricingRules, tier: Tier, billed: number): { tier_bps: number; less_bps: number; margin_bps: number } {
  const tierBps = rules.tiers[tier].margin_bps;
  let less = 0;
  for (const b of rules.qty_breaks) if (billed >= b.min_qty && b.less_bps > less) less = b.less_bps;
  return { tier_bps: tierBps, less_bps: less, margin_bps: Math.max(rules.floor_margin_bps, tierBps - less) };
}

/** Unit price = cost / (1 - margin), rounded up to the cent. */
export function unitPriceCents(costCents: number, marginBps: number): number {
  return ceilDiv(costCents * 10_000, 10_000 - marginBps);
}

/** The margin a unit price really earns, in basis points, rounded down. Negative when below cost. */
export function actualMarginBps(unitCents: number, costCents: number): number {
  return Math.floor(((unitCents - costCents) * 10_000) / unitCents);
}

/** Converts the buyer's quantity to the part's selling unit. Packs become pieces when the part comes in packs. */
export function unitsFor(qty: number, uom: Uom, part: Pick<Part, 'uom' | 'pack_qty'>): { units: number; note: string | null } {
  if (uom === 'PK') {
    if (part.pack_qty > 1) return { units: qty * part.pack_qty, note: `${qty} pack${qty === 1 ? '' : 's'} of ${part.pack_qty} = ${qty * part.pack_qty} ${part.uom}` };
    return { units: qty, note: `Asked in packs, but this part is sold by the ${part.uom === 'FT' ? 'foot' : 'piece'}; quoted ${qty} ${part.uom}` };
  }
  if (uom !== part.uom) return { units: qty, note: `Asked in ${uom}, sold in ${part.uom}; quoted ${qty} ${part.uom}` };
  return { units: qty, note: null };
}

export function priceLine(input: PriceInput, rules: PricingRules, holidays: readonly string[]): PriceResult {
  for (const [k, v] of Object.entries({ qty: input.qty, pack_qty: input.pack_qty, cost_cents: input.cost_cents, stock_qty: input.stock_qty, lead_time_days: input.lead_time_days })) {
    if (!Number.isSafeInteger(v) || v < 0 || ((k === 'qty' || k === 'pack_qty' || k === 'cost_cents') && v === 0)) throw new Error(`priceLine: ${k} must be a positive whole number, got ${v}`);
  }
  if (input.override_unit_cents != null && (!Number.isSafeInteger(input.override_unit_cents) || input.override_unit_cents <= 0)) {
    throw new Error(`priceLine: the unit price override must be a positive number of cents, got ${input.override_unit_cents}`);
  }
  const billed = billedQty(input.qty, input.pack_qty);
  const m = marginFor(rules, input.tier, billed);
  const listUnit = unitPriceCents(input.cost_cents, m.margin_bps);
  const unit = input.override_unit_cents ?? listUnit;
  const extended = unit * billed;
  const minAdjust = extended < rules.min_line_cents ? rules.min_line_cents - extended : 0;

  const inStock = input.stock_qty >= billed;
  const lt = rules.lead_time;
  let ship = addBusinessDays(input.quote_date, (inStock ? 0 : input.lead_time_days) + lt.handling_days, holidays);
  let arrive = addBusinessDays(ship, lt.transit_days, holidays);
  let rush = false;
  if (input.due_date && arrive > input.due_date && inStock) {
    const rushShip = addBusinessDays(input.quote_date, rules.rush.handling_days, holidays);
    const rushArrive = addBusinessDays(rushShip, rules.rush.transit_days, holidays);
    if (rushArrive <= input.due_date) {
      rush = true;
      ship = rushShip;
      arrive = rushArrive;
    }
  }
  const rushFee = rush && !input.rush_fee_waived ? Math.max(ceilDiv((extended + minAdjust) * rules.rush.fee_bps, 10_000), rules.rush.min_fee_cents) : 0;
  const partial = !inStock && input.stock_qty > 0
    ? { qty: input.stock_qty, arrive_date: addBusinessDays(addBusinessDays(input.quote_date, lt.handling_days, holidays), lt.transit_days, holidays) }
    : null;

  return {
    qty: input.qty,
    billed_qty: billed,
    pack_qty: input.pack_qty,
    pack_rounded: billed !== input.qty,
    cost_cents: input.cost_cents,
    tier: input.tier,
    tier_margin_bps: m.tier_bps,
    break_less_bps: m.less_bps,
    margin_bps: m.margin_bps,
    list_unit_cents: listUnit,
    unit_cents: unit,
    overridden: input.override_unit_cents != null,
    actual_margin_bps: actualMarginBps(unit, input.cost_cents),
    extended_cents: extended,
    min_line_adjust_cents: minAdjust,
    rush,
    rush_fee_waived: rush && input.rush_fee_waived,
    rush_fee_cents: rushFee,
    line_total_cents: extended + minAdjust + rushFee,
    cost_total_cents: input.cost_cents * billed,
    in_stock: inStock,
    stock_qty: input.stock_qty,
    lead_time_days: input.lead_time_days,
    ship_date: ship,
    arrive_date: arrive,
    partial,
    due_date: input.due_date,
    misses_due: Boolean(input.due_date && arrive > input.due_date),
  };
}
