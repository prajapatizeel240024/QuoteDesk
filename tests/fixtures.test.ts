import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { loadErpExport } from '@/server/erp/catalog';
import { listFixtures, MessageZ, parseFixture } from '@/server/ingest/fixture';
import { priceLine, unitsFor } from '@/server/pricing/engine';
import { listRfqs, loadKey } from '../evals/score';

const cfg = loadConfig();
const parts = new Map(loadErpExport().parts.map((p) => [p.sku, p]));

describe('synthetic fixtures and answer keys', () => {
  it('has 15 RFQs: 10 dev and 5 holdout, each with a key', () => {
    expect(listFixtures()).toHaveLength(15);
    expect(listRfqs('dev')).toHaveLength(10);
    expect(listRfqs('holdout')).toHaveLength(5);
  });
  for (const id of listFixtures()) {
    it(`${id}: the email validates, every attachment parses, every expected part is in the catalog`, async () => {
      const raw = JSON.parse(fs.readFileSync(path.join('evals', 'rfqs', id, 'message.json'), 'utf8'));
      expect(() => MessageZ.parse(raw)).not.toThrow();
      const { docs } = await parseFixture(id);
      expect(docs).toHaveLength(raw.attachments.length + 1);
      for (const d of docs) if (d.kind === 'xlsx') expect(d.sheets!.some((s) => s.rows.length > 3)).toBe(true);
      for (const d of docs) if (d.kind === 'pdf') expect(d.pdf!.lines.length).toBeGreaterThan(5);
      const key = loadKey(id);
      expect(key.lines.length).toBeGreaterThanOrEqual(3);
      for (const l of key.lines) for (const s of [l.expected.sku, l.expected.quoted_sku]) if (s) expect(parts.has(s)).toBe(true);
    });
  }
  it("the generator's reference prices agree with the pricing engine on every line", () => {
    let checked = 0;
    for (const id of listRfqs()) {
      const key = loadKey(id);
      const tier = cfg.customers.find((c) => c.id === key.customer_id)!.tier;
      const waived = cfg.customers.find((c) => c.id === key.customer_id)!.rules.rush_fee_waived;
      for (const l of key.lines.filter((x) => x.expected.price)) {
        const part = parts.get(l.expected.quoted_sku!)!;
        const units = unitsFor(l.expected.qty!, l.expected.uom, part).units;
        const p = priceLine({ cost_cents: part.cost_cents, qty: units, pack_qty: part.pack_qty, tier, quote_date: key.quote_date, due_date: l.expected.due_date, stock_qty: part.stock_qty, lead_time_days: part.lead_time_days, rush_fee_waived: waived }, cfg.pricing, cfg.distributor.holidays);
        const e = l.expected.price!;
        expect({ id: `${id} ${l.id}`, billed: p.billed_qty, unit: p.unit_cents, ext: p.extended_cents, min: p.min_line_adjust_cents, rush: p.rush_fee_cents, total: p.line_total_cents, arrive: p.arrive_date }).toEqual({ id: `${id} ${l.id}`, billed: e.billed_qty, unit: e.unit_cents, ext: e.extended_cents, min: e.min_line_adjust_cents, rush: e.rush_fee_cents, total: e.line_total_cents, arrive: e.arrive_date });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(55);
  });
  it('is synthetic only: .example domains, 555-01xx numbers, no defense markings', () => {
    const text = [...listFixtures().map((id) => fs.readFileSync(path.join('evals', 'rfqs', id, 'message.json'), 'utf8')), ...['catalog.csv', 'suppliers.csv'].map((f) => fs.readFileSync(path.join('data', 'erp', f), 'utf8')), fs.readFileSync('config/quotedesk.yaml', 'utf8')].join('\n');
    for (const email of text.match(/[\w.+-]+@[\w.-]+/g) ?? []) expect(email).toMatch(/\.example$/);
    for (const phone of text.match(/\+1-\d{3}-\d{3}-\d{4}/g) ?? []) expect(phone).toMatch(/-555-01\d\d$/);
    expect(text).not.toMatch(/\b(ITAR|USML|ECCN|MIL-(?:STD|SPEC|DTL)|NSN|DFARS)\b/i);
  });
});
