import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { addBusinessDays, businessDaysBetween, subtractBusinessDays } from '@/lib/dates';
import { money, pct } from '@/lib/format';
import type { PriceInput } from '@/lib/types';
import { billedQty, ceilDiv, marginFor, priceLine, unitPriceCents, unitsFor } from '@/server/pricing/engine';

const cfg = loadConfig();
const R = cfg.pricing;
const H = cfg.distributor.holidays;
const base: PriceInput = { cost_cents: 41, qty: 500, pack_qty: 50, tier: 'A', quote_date: '2026-10-06', due_date: '2026-10-20', stock_qty: 380, lead_time_days: 8, rush_fee_waived: false };

describe('integer math', () => {
  it('ceilDiv rounds up without floating point', () => {
    expect(ceilDiv(410_000, 8600)).toBe(48);
    expect(ceilDiv(10, 5)).toBe(2);
    expect(() => ceilDiv(1.5, 2)).toThrow();
  });
  it('rounds quantities up to whole packs', () => {
    expect(billedQty(250, 100)).toBe(300);
    expect(billedQty(300, 100)).toBe(300);
    expect(billedQty(40, 50)).toBe(50);
  });
  it('takes the biggest quantity break and never goes under the floor', () => {
    expect(marginFor(R, 'A', 99)).toEqual({ tier_bps: 1800, less_bps: 0, margin_bps: 1800 });
    expect(marginFor(R, 'A', 500)).toEqual({ tier_bps: 1800, less_bps: 400, margin_bps: 1400 });
    expect(marginFor(R, 'C', 2000).margin_bps).toBe(2400);
    expect(marginFor({ ...R, floor_margin_bps: 1500 }, 'A', 5000).margin_bps).toBe(1500);
  });
  it('prices as cost / (1 - margin), rounded up to the cent', () => {
    expect(unitPriceCents(760, 2400)).toBe(1000);
    expect(unitPriceCents(4980, 2400)).toBe(6553);
  });
  it('converts packs to pieces', () => {
    expect(unitsFor(1, 'PK', { uom: 'EA', pack_qty: 100 }).units).toBe(100);
    expect(unitsFor(25, 'FT', { uom: 'FT', pack_qty: 1 })).toEqual({ units: 25, note: null });
  });
});

describe('priceLine', () => {
  it('quotes a short-stock line: break margin, lead time, partial and the missed date', () => {
    const p = priceLine(base, R, H);
    expect(p).toMatchObject({ billed_qty: 500, margin_bps: 1400, unit_cents: 48, extended_cents: 24_000, line_total_cents: 24_000, in_stock: false, ship_date: '2026-10-19', arrive_date: '2026-10-21', misses_due: true, partial: { qty: 380, arrive_date: '2026-10-09' } });
  });
  it('adds the minimum line charge to small lines', () => {
    const p = priceLine({ ...base, cost_cents: 4, qty: 200, pack_qty: 100, stock_qty: 4000, due_date: null }, R, H);
    expect(p).toMatchObject({ unit_cents: 5, extended_cents: 1000, min_line_adjust_cents: 500, line_total_cents: 1500, misses_due: false });
  });
  it('ships rush when that makes the date, with a percentage fee', () => {
    const p = priceLine({ ...base, cost_cents: 760, qty: 30, pack_qty: 1, tier: 'B', quote_date: '2026-10-07', due_date: '2026-10-09', stock_qty: 140 }, R, H);
    expect(p).toMatchObject({ rush: true, arrive_date: '2026-10-08', rush_fee_cents: 4500, line_total_cents: 34_500, misses_due: false });
  });
  it('charges at least the minimum rush fee, and nothing when the customer has it waived', () => {
    const small = { ...base, cost_cents: 4980, qty: 2, pack_qty: 1, tier: 'B' as const, quote_date: '2026-10-16', due_date: '2026-10-20', stock_qty: 5 };
    expect(priceLine(small, R, H)).toMatchObject({ unit_cents: 6553, rush: true, rush_fee_cents: 2500, line_total_cents: 15_606 });
    expect(priceLine({ ...small, rush_fee_waived: true }, R, H)).toMatchObject({ rush: true, rush_fee_waived: true, rush_fee_cents: 0, line_total_cents: 13_106 });
  });
  it("doesn't rush when even rush can't make the date", () => {
    const p = priceLine({ ...base, qty: 100, quote_date: '2026-10-07', due_date: '2026-10-07' }, R, H);
    expect(p).toMatchObject({ rush: false, misses_due: true, rush_fee_cents: 0 });
  });
  it('uses a hand-set unit price but keeps the list price and the real margin', () => {
    const p = priceLine({ ...base, override_unit_cents: 30 }, R, H);
    expect(p).toMatchObject({ unit_cents: 30, list_unit_cents: 48, overridden: true, actual_margin_bps: -3667, extended_cents: 15_000 });
  });
  it('refuses bad input instead of guessing', () => {
    expect(() => priceLine({ ...base, qty: 0 }, R, H)).toThrow();
    expect(() => priceLine({ ...base, cost_cents: 4.5 }, R, H)).toThrow();
    expect(() => priceLine({ ...base, override_unit_cents: -1 }, R, H)).toThrow();
  });
});

describe('business days', () => {
  it('skips weekends and holidays', () => {
    expect(addBusinessDays('2026-10-09', 1, H)).toBe('2026-10-12');
    expect(addBusinessDays('2026-10-10', 0, H)).toBe('2026-10-12');
    expect(addBusinessDays('2026-11-25', 1, H)).toBe('2026-11-30');
    expect(subtractBusinessDays('2026-10-20', 3, H)).toBe('2026-10-15');
    expect(businessDaysBetween('2026-10-05', '2026-10-12', H)).toBe(5);
  });
  it('formats money and percents from integers', () => {
    expect([money(0), money(5), money(123456), money(-250)]).toEqual(['$0.00', '$0.05', '$1,234.56', '-$2.50']);
    expect([pct(1800), pct(-3667), pct(1405)]).toEqual(['18.0%', '-36.6%', '14.0%']);
  });
});
