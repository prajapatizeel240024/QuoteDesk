// Extraction and matching on the dev RFQs, with the answer-key stand-in playing Claude.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import type { LLM } from '@/lib/types';
import { loadErpExport } from '@/server/erp/catalog';
import { extractRfq } from '@/server/extract/index';
import { parseFixture } from '@/server/ingest/fixture';
import { matchLines } from '@/server/match/index';
import { buildIndex, exactLookup } from '@/server/match/rules';
import { keyLineFor, listRfqs, loadKey, oracleLLM } from '../evals/score';

const cfg = loadConfig();
const erp = loadErpExport();
const idx = buildIndex(erp.parts, erp.xref, { synonyms: cfg.matching.synonyms, stop: cfg.matching.stop_words });

async function run(id: string) {
  const sent: string[] = [];
  const o = oracleLLM();
  const llm: LLM = { name: 'oracle', extract: async (r) => (sent.push(...r.blocks.map((b) => b.text)), o.extract(r)), match: async (i) => (sent.push(...i.map((x) => x.request)), o.match(i)), question: o.question };
  const key = loadKey(id);
  const { message, docs } = await parseFixture(id);
  const customer = cfg.customers.find((c) => c.id === key.customer_id)!;
  const ex = await extractRfq({ rfqRef: id, from: message.from.email, subject: message.subject, quoteDate: key.quote_date, docs, customer, cfg, findPart: (s) => exactLookup(s, customer.id, idx)?.skus[0] ?? null, llm });
  const held = ex.lines.map((l) => l.export_marked || Boolean(l.screened_term));
  const m = await matchLines(ex.lines.map((line, i) => ({ line, held: held[i] })), { rfqRef: id, customerId: customer.id, idx, llm, threshold: 0.8 });
  return { key, ex, m, held, sent: sent.join('\n').toLowerCase() };
}

describe('extraction and matching on the dev RFQs', () => {
  for (const id of listRfqs('dev')) {
    it(`${id}: finds every line, reads every field, never places a wrong part`, async () => {
      const { key, ex, m } = await run(id);
      expect(ex.lines).toHaveLength(key.lines.length);
      const taken = new Set<string>();
      ex.lines.forEach((l, i) => {
        const k = keyLineFor(key, l.source, taken)!;
        expect(k, `${id} line ${i + 1} has no key line`).toBeTruthy();
        taken.add(k.id);
        expect({ line: k.id, qty: l.qty, uom: l.uom, due: l.due_date, certs: l.certs, unclear: l.certs_unclear }).toEqual({ line: k.id, qty: k.expected.qty, uom: k.expected.uom, due: k.expected.due_date, certs: k.expected.certs, unclear: k.expected.certs_unclear });
        const mm = m.matches[i];
        if (mm.status === 'auto') expect(mm.sku, `${id} ${k.id}`).toBe(k.expected.sku);
        if (k.expected.review && !(k.expected.export_hold && k.expected.export_hold !== 'catalog')) expect(mm.status, `${id} ${k.id} should go to a person`).toBe('needs_review');
      });
    });
  }
  it('sends no text from export-held lines to Claude', async () => {
    for (const id of ['rfq-06', 'rfq-07']) {
      const { key, sent } = await run(id);
      for (const k of key.lines.filter((x) => x.expected.export_hold === 'marked' || x.expected.export_hold === 'screened')) expect(sent).not.toContain(k.requested.description.toLowerCase());
    }
  });
  it('asks Claude only about free text and hard matches', async () => {
    const r1 = await run('rfq-01');
    expect(r1.ex.asked_claude).toBe(false);
    expect(r1.m.asked).toBe(0);
    const r3 = await run('rfq-03');
    expect(r3.ex.asked_claude).toBe(true);
    expect(r3.ex.lines[6]).toMatchObject({ method: 'claude', source: { doc: 'email body' }, due_date: '2026-10-20' });
  });
});
