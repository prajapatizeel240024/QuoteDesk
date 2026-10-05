// Runs against the local eval database (reset here), with the answer-key stand-in instead of Claude.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '@/lib/config';
import { MatchOutputZ } from '@/lib/schemas';
import { closePools, dbUrl, getPool, migrate, resetDb } from '@/server/db';
import { generateQuote } from '@/server/export/quote-email';
import { draftPurchaseOrders } from '@/server/export/purchase-orders';
import { ingestFixture } from '@/server/ingest/fixture';
import { callStructured, LLMUnavailableError, ModelOutputError } from '@/server/llm/client';
import { cacheKey } from '@/server/llm/cache';
import { approveLine, clearExport, editLine, getLineHistory, getLineViews, rejectLine, reopenLine, resolvePart, type LineView } from '@/server/lines/service';
import { jsonError, runRfq } from '@/server/pipeline';
import { oracleLLM } from '../evals/score';

const url = dbUrl('eval');
const pool = getPool(url);
const rep = 'rep:MO';
const ids: Record<string, string> = {};

beforeAll(async () => {
  await migrate(url);
  await resetDb(url);
  for (const f of ['rfq-03', 'rfq-06', 'rfq-08']) {
    ids[f] = (await ingestFixture(pool, f)).rfqId;
    await runRfq(pool, ids[f], () => undefined, { llm: oracleLLM(), threshold: 0.8 });
  }
});
afterAll(() => closePools());

const lines = (f: string) => getLineViews(pool, { rfqId: ids[f] });
const line = async (f: string, n: number): Promise<LineView> => (await lines(f)).find((l) => l.line_no === n)!;
const audits = async (id: string) => (await pool.query<{ n: number }>(`select count(*)::int as n from audit_events where subject_type = 'line' and subject_id = $1`, [id])).rows[0].n;

describe('the lines service', () => {
  it('drafts the demo RFQ with code prices, a customer-rule approval and a part question', async () => {
    const ls = await lines('rfq-03');
    expect(ls.map((l) => l.part_sku)).toEqual(['AF-10117', null, 'AF-30102', 'AF-10205', 'AF-40190', 'AF-30401', 'AF-30501']);
    expect(ls[3]).toMatchObject({ status: 'approved', approved_by: 'rule:C-1001/In-stock catalog parts under $500' });
    expect(ls[1]).toMatchObject({ match_status: 'needs_review', candidates: [{ sku: 'AF-20103' }, { sku: 'AF-20104' }] });
    expect(ls[0].price).toMatchObject({ unit_cents: 48, line_total_cents: 24_000, misses_due: true });
    const q = await pool.query('select drafted_by, body from buyer_questions where rfq_id = $1', [ids['rfq-03']]);
    expect(q.rows[0].body).toMatch(/Line 3 \("KF-JM-0808, JIC adapter -8 x 1\/2 NPT"\): what quantity/);
  });

  it('writes exactly one audit row per edit and re-prices with code', async () => {
    const l = await line('rfq-03', 3);
    const before = await audits(l.id);
    await editLine(pool, l.id, { version: l.version, qty: 40 }, rep);
    const after = await line('rfq-03', 3);
    expect(await audits(l.id)).toBe(before + 1);
    expect(after.price).toMatchObject({ billed_qty: 40, unit_cents: 354, line_total_cents: 14_160 });
    expect(after.flags).toEqual([]);
    await expect(editLine(pool, l.id, { version: l.version, qty: 41 }, rep)).rejects.toMatchObject({ status: 409 });
  });

  it('needs a reason for a hand price under the floor; reopen keeps the reason, an edit clears it', async () => {
    let l = await line('rfq-03', 6);
    await expect(editLine(pool, l.id, { version: l.version, price_override_cents: 1000 }, rep)).rejects.toMatchObject({ status: 422 });
    await editLine(pool, l.id, { version: l.version, price_override_cents: 1000, price_override_reason: 'Match last order' }, rep);
    l = await line('rfq-03', 6);
    expect(l.flags.map((f) => f.code)).toEqual(['PRICE_OVERRIDE', 'BELOW_FLOOR']);
    await expect(approveLine(pool, l.id, { version: l.version }, rep)).rejects.toMatchObject({ status: 422 });
    await approveLine(pool, l.id, { version: l.version, override_reason: 'Manager approved' }, rep);
    l = await line('rfq-03', 6);
    await reopenLine(pool, l.id, { version: l.version }, rep);
    l = await line('rfq-03', 6);
    await approveLine(pool, l.id, { version: l.version }, rep); // the reason is still there
    l = await line('rfq-03', 6);
    await reopenLine(pool, l.id, { version: l.version }, rep);
    l = await line('rfq-03', 6);
    await editLine(pool, l.id, { version: l.version, price_override_cents: 1100, price_override_reason: 'Match last order' }, rep);
    l = await line('rfq-03', 6);
    await expect(approveLine(pool, l.id, { version: l.version }, rep)).rejects.toMatchObject({ status: 422 });
    await editLine(pool, l.id, { version: l.version, price_override_cents: null }, rep);
    expect((await line('rfq-03', 6)).price?.unit_cents).toBe(1440);
  });

  it('resolves "Needs a part" and swaps an obsolete part for its replacement', async () => {
    const q = await line('rfq-03', 2);
    await resolvePart(pool, q.id, { version: q.version, part_sku: 'AF-20103' }, rep);
    expect(await line('rfq-03', 2)).toMatchObject({ part_sku: 'AF-20103', match_method: 'rep', match_status: 'resolved' });
    const o = await line('rfq-03', 5);
    await expect(approveLine(pool, o.id, { version: o.version }, rep)).rejects.toMatchObject({ status: 422 });
    await editLine(pool, o.id, { version: o.version, part_sku: 'AF-40101' }, rep);
    const swapped = await line('rfq-03', 5);
    expect(swapped).toMatchObject({ part_sku: 'AF-40101', requested_sku: 'AF-40190' });
    expect(swapped.flags.map((f) => f.code)).toEqual(['SUBSTITUTED']);
    const [h] = await getLineHistory(pool, o.id);
    expect(h).toMatchObject({ action: 'edited', actor: rep });
  });

  it('builds the quote email only when every line is decided, from code prices', async () => {
    await expect(generateQuote(pool, ids['rfq-03'], rep)).rejects.toMatchObject({ status: 409 });
    for (const l of (await lines('rfq-03')).filter((x) => x.status === 'draft')) await approveLine(pool, l.id, { version: l.version }, rep);
    const q = await generateQuote(pool, ids['rfq-03'], rep);
    expect(q.quote_number).toBe('Q-1001-20261006');
    expect(q.text).toContain('1. AF-10117  Hex cap screw, 1/2-13 x 2 in, Grade 5, zinc plated\n   Your part HPV-100233. 500 EA at $0.48 each = $240.00\n   380 can arrive by Oct 9 and the rest by Oct 21. You asked for Oct 20.');
    expect(q.text).toContain('Replaces AF-40190 (VE-PX12-4P-L), which is discontinued.');
    expect(q.text).toMatch(/Total: \$1,037\.54/);
    expect((await generateQuote(pool, ids['rfq-03'], rep)).quote_number).toBe('Q-1001-20261006-2');
  });

  it('drafts supplier POs for the shortfall, rounded to the order multiple', async () => {
    const [po] = await draftPurchaseOrders(pool, ids['rfq-03'], rep);
    expect(po).toMatchObject({ po_number: 'PO-TAL-20261006-1', total_cents: 6150, lines: [{ sku: 'AF-10117', shortfall: 120, order_qty: 150, needed_by: '2026-10-15' }] });
  });

  it('holds export lines: no price, no approval, until a named person clears them', async () => {
    const held = (await lines('rfq-06')).find((l) => l.export_hold)!;
    expect(held).toMatchObject({ export_hold: 'marked', price: null });
    await expect(approveLine(pool, held.id, { version: held.version }, rep)).rejects.toMatchObject({ status: 409 });
    await clearExport(pool, held.id, { version: held.version, reviewer: 'Dana Cole', reason: 'End use checked' }, rep);
    const cleared = (await lines('rfq-06')).find((l) => l.id === held.id)!;
    expect(cleared.price?.line_total_cents).toBe(26_732);
    expect(cleared.flags).toMatchObject([{ code: 'EXPORT_CONTROLLED', severity: 'info' }]);
  });

  it('marks unknown parts as not carried and keeps them out of the quote', async () => {
    const u = (await lines('rfq-08')).find((l) => l.match_status === 'needs_review')!;
    expect(u.flags.map((f) => f.code)).toContain('UNKNOWN_PART');
    await resolvePart(pool, u.id, { version: u.version, not_carried: true }, rep);
    expect((await lines('rfq-08')).find((l) => l.id === u.id)).toMatchObject({ status: 'rejected', not_carried: true });
    const any = (await lines('rfq-08')).find((l) => l.status === 'draft')!;
    await rejectLine(pool, any.id, { version: any.version, reason: 'Customer will source it' }, rep);
  });

  it('keeps the audit log append-only', async () => {
    await expect(pool.query(`update audit_events set actor = 'someone else'`)).rejects.toThrow(/append-only/);
    await expect(pool.query('delete from audit_events')).rejects.toThrow(/append-only/);
  });
});

describe('the Claude client', () => {
  const call = { purpose: 'match' as const, model: 'test-model', promptVersion: 'match.v1', system: 'system text', user: 'user text', schema: { type: 'object' }, zod: MatchOutputZ, maxTokens: 50 };
  const key = cacheKey({ model: call.model, prompt: call.promptVersion, system: call.system, user: call.user, schema: call.schema });
  const insert = (response: unknown) => pool.query(`insert into llm_calls (purpose, model, prompt_version, cache_key, request, response, stop_reason) values ('match', 'test-model', 'match.v1', $1, '{}', $2, 'end_turn')`, [key, JSON.stringify(response)]);

  it('ignores a cached answer that fails validation, and replays a good one', async () => {
    loadEnv();
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = '';
    try {
      await insert({ nonsense: true });
      await expect(callStructured(pool, call)).rejects.toBeInstanceOf(LLMUnavailableError);
      await insert({ matches: [] });
      await expect(callStructured(pool, call)).resolves.toEqual({ matches: [] });
    } finally {
      process.env.ANTHROPIC_API_KEY = saved;
    }
  });
  it('maps model problems to 502 and a missing key to 503', async () => {
    expect(jsonError(new ModelOutputError('x')).status).toBe(502);
    expect(jsonError(new LLMUnavailableError('x')).status).toBe(503);
  });
});
