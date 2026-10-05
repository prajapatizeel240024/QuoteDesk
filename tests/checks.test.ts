import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '@/lib/config';
import type { Part } from '@/lib/types';
import { failedConditions, autoApproveRule } from '@/server/automation/rules';
import { checkLine, type LineFacts } from '@/server/checks/rules';
import { loadErpExport } from '@/server/erp/catalog';
import { priceLine } from '@/server/pricing/engine';
import { buyerWords, questionProblems } from '@/server/questions/index';
import { templateQuestion } from '@/server/questions/template';
import fs from 'node:fs';

const cfg = loadConfig();
const parts = new Map(loadErpExport().parts.map((p) => [p.sku, p]));
const P = (sku: string) => parts.get(sku) as Part;
const ctx = { floor_margin_bps: cfg.pricing.floor_margin_bps, min_line_cents: cfg.pricing.min_line_cents };
const facts = (o: Partial<LineFacts>): LineFacts => ({ requested: { part_text: '', description: 'x', qty_text: '1', uom_text: '', due_text: '', certs_text: '', export_text: '' }, qty: 1, certs: [], certs_unclear: false, missing: [], match_status: 'auto', part: P('AF-30401'), requested_part: null, replacement: null, claude_said_none: false, export_hold: null, export_term: null, export_cleared: null, price: null, override: null, ...o });
const codes = (f: LineFacts) => checkLine(f, ctx).map((x) => `${x.code}:${x.severity}`);

describe('line checks', () => {
  it('holds export lines and says nothing else about the part until cleared', () => {
    expect(codes(facts({ part: null, match_status: 'needs_review', export_hold: 'screened', export_term: 'motion controller' }))).toEqual(['EXPORT_CONTROLLED:block']);
    expect(codes(facts({ part: null, match_status: 'needs_review', export_hold: 'screened', export_cleared: { by: 'Dana', reason: 'ok' } }))).toEqual(['EXPORT_CONTROLLED:info', 'UNKNOWN_PART:block']);
  });
  it('blocks obsolete parts and names the replacement', () => {
    const f = checkLine(facts({ part: P('AF-40190'), replacement: P('AF-40101') }), ctx);
    expect(f[0]).toMatchObject({ code: 'OBSOLETE_PART', severity: 'block' });
    expect(f[0].message).toMatch(/AF-40101/);
  });
  it('blocks a missing quantity or cert type, but only warns about a missing date', () => {
    expect(codes(facts({ missing: ['qty'] }))).toEqual(['MISSING_INFO:block']);
    expect(codes(facts({ missing: ['due_date'] }))).toEqual(['MISSING_INFO:warn']);
    expect(codes(facts({ missing: ['cert_type'], certs_unclear: true }))).toEqual(['MISSING_INFO:block']);
  });
  it('warns when a requested cert is not available', () => expect(codes(facts({ part: P('AF-30201'), certs: ['CoC', 'MTR'] }))).toEqual(['CERT_UNAVAILABLE:warn']));
  it('raises price flags from the priced line, and blocks a hand price under the floor', () => {
    const price = priceLine({ cost_cents: 41, qty: 520, pack_qty: 50, tier: 'A', quote_date: '2026-10-06', due_date: '2026-10-20', stock_qty: 380, lead_time_days: 8, rush_fee_waived: false, override_unit_cents: 42 }, cfg.pricing, cfg.distributor.holidays);
    expect(codes(facts({ part: P('AF-10117'), price, override: { unit_cents: 42, reason: 'Match last order' } }))).toEqual(['PACK_ROUNDED:warn', 'LEAD_TIME_MISS:warn', 'STOCK_SHORT:info', 'PRICE_OVERRIDE:warn', 'BELOW_FLOOR:block']);
  });
});

describe('customer automation rules', () => {
  const rules = cfg.customers.find((c) => c.id === 'C-1001')!.rules;
  const price = priceLine({ cost_cents: 9, qty: 400, pack_qty: 100, tier: 'A', quote_date: '2026-10-05', due_date: '2026-10-16', stock_qty: 2400, lead_time_days: 8, rush_fee_waived: false }, cfg.pricing, cfg.distributor.holidays);
  const ok = { status: 'draft', export_hold: null, match_method: 'rule' as const, part: P('AF-10205'), price, flags: [] };
  it('approves a clean in-stock rule match under the limit', () => expect(autoApproveRule(rules as never, ok)).toBe('In-stock catalog parts under $500'));
  it('says which condition failed', () => {
    const when = rules.auto_approve[0].when;
    expect(failedConditions(when, { ...ok, match_method: 'claude' })).toEqual(['the part was matched by claude']);
    expect(failedConditions(when, { ...ok, export_hold: 'catalog' })).toContain('export-controlled lines always need a person');
    expect(failedConditions(when, { ...ok, flags: [{ code: 'PACK_ROUNDED', severity: 'warn', message: '', evidence: [] }] })).toEqual(['the line has flags']);
  });
  it('rejects a misspelled rule key in the YAML', () => {
    const raw = fs.readFileSync('config/quotedesk.yaml', 'utf8').replace('stock_covers: true, no_flags', 'stock_cover: true, no_flags');
    expect(() => parseConfig(raw)).toThrow(/stock_cover/);
  });
});

describe('question for the buyer', () => {
  const req = { rfq_ref: 'x', buyer_first_name: 'Priya', rep_first_name: 'Maya', rfq_subject: 'RFQ 4471', asks: [{ line_no: 3, buyer_words: 'KF-JM-0808, JIC adapter', fields: ['qty' as const] }] };
  it('uses the buyer’s own words', () => expect(buyerWords({ part_text: 'KF-JM-0808', description: 'JIC adapter', qty_text: '', uom_text: '', due_text: '', certs_text: '', export_text: '' })).toBe('KF-JM-0808, JIC adapter'));
  it('the template asks about every line and passes its own checks', () => {
    const t = templateQuestion(req);
    expect(t.body).toMatch(/Line 3 \("KF-JM-0808, JIC adapter"\): what quantity/);
    expect(questionProblems(t, req)).toEqual([]);
  });
  it('rejects a draft that mentions prices or skips a line', () => expect(questionProblems({ subject: 'Re: RFQ', body: 'Hi Priya, the price is $40. Thanks, Maya' }, req)).toEqual(["doesn't mention line 3", 'mentions prices']));
});
