// npm run eval -- [--split dev|holdout|all] [--llm anthropic|oracle] [--threshold 0.8] [--no-cache]
// Runs the real pipeline on each synthetic RFQ against a fresh local eval database and scores it against the
// answer keys twice: "auto" (before any human click) and "after review" (a perfect rep picks the right part for
// every line in "Needs a part"). Writes evals/reports/<time>-<split>-<llm>.md and .json.
import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { loadConfig, loadEnv } from '@/lib/config';
import type { LLM } from '@/lib/types';
import { closePools, dbUrl, getPool, migrate, resetDb } from '@/server/db';
import { ingestFixture } from '@/server/ingest/fixture';
import { getLLM, models } from '@/server/llm/client';
import { getLineViews, resolvePart, type LineView } from '@/server/lines/service';
import { decide, parseThreshold, requestText } from '@/server/match/index';
import { loadCatalogIndex, runRfq } from '@/server/pipeline';
import { keyLineFor, listRfqs, loadKey, scoreRfq, type RfqScore, type SysLine } from './score';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function toSys(l: LineView): SysLine {
  return { id: l.id, line_no: l.line_no, source: l.source, extraction_method: l.extraction_method, qty: l.qty, uom: l.uom, due_date: l.due_date, certs: l.certs, certs_unclear: l.certs_unclear, part_sku: l.part_sku, requested_sku: l.requested_sku, match_status: l.match_status, match_method: l.match_method, export_hold: l.export_hold, status: l.status, approved_by: l.approved_by, price: l.price, flags: l.flags };
}

/** Wraps the LLM to keep everything QuoteDesk sends, so the report can prove held lines never left. */
function recording(llm: LLM, sent: string[]): LLM {
  return {
    name: llm.name,
    extract: async (r) => (sent.push(JSON.stringify(r.blocks.map((b) => b.text))), llm.extract(r)),
    match: async (items) => (sent.push(JSON.stringify(items.map((i) => i.request))), llm.match(items)),
    question: async (r) => (sent.push(JSON.stringify(r.asks)), llm.question(r)),
  };
}

const sum = (xs: RfqScore[], f: (s: RfqScore) => number) => xs.reduce((a, s) => a + f(s), 0);
const ratio = (a: number, b: number) => (b ? (a / b).toFixed(2) : 'n/a');
const pctl = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : 0);

async function main() {
  loadEnv();
  const split = (arg('--split') ?? 'dev') as 'dev' | 'holdout' | 'all';
  if (arg('--llm')) process.env.LLM_MODE = arg('--llm');
  if (process.argv.includes('--no-cache')) process.env.LLM_CACHE = 'off';
  const mode = process.env.LLM_MODE ?? 'anthropic';
  if (mode === 'oracle' && split !== 'dev') throw new Error('The oracle answers from the keys, so running it on the holdout would show you the answers. Use --split dev.');
  const threshold = parseThreshold(arg('--threshold') ?? process.env.MATCH_THRESHOLD);
  const url = dbUrl('eval');
  await migrate(url);
  await resetDb(url); // keeps llm_calls, so repeated runs replay Claude's answers unless --no-cache
  const pool: Pool = getPool(url);
  const cfg = loadConfig();
  const base = await getLLM(pool);
  const startedAt = new Date();
  const ids = listRfqs(split);
  const auto: RfqScore[] = [];
  const after: RfqScore[] = [];
  const runMs: number[] = [];
  const leaks: string[] = [];
  const sweepLines: { line: LineView; want: string | null; review: boolean }[] = [];

  for (const id of ids) {
    const key = loadKey(id);
    const sent: string[] = [];
    const { rfqId } = await ingestFixture(pool, id, 'eval');
    await runRfq(pool, rfqId, () => undefined, { llm: recording(base, sent), threshold });
    const t = await pool.query<{ run_ms: number }>('select run_ms from rfqs where id = $1', [rfqId]);
    runMs.push(t.rows[0].run_ms);
    const lines = await getLineViews(pool, { rfqId });
    auto.push(scoreRfq(key, lines.map(toSys)));
    const text = sent.join('\n').toLowerCase();
    for (const k of key.lines.filter((x) => x.expected.export_hold === 'marked' || x.expected.export_hold === 'screened')) {
      const words = [k.requested.description, k.source.quote ?? ''].filter((w) => w.length > 6).map((w) => w.toLowerCase());
      if (words.some((w) => text.includes(w))) leaks.push(`${id} ${k.id}`);
    }
    const taken = new Set<string>();
    for (const l of lines) {
      const k = keyLineFor(key, l.source, taken);
      if (!k) continue;
      taken.add(k.id);
      if (l.match_suggestion) sweepLines.push({ line: l, want: k.expected.sku, review: k.expected.review });
      // A perfect rep clears "Needs a part" from the key. Lines the key says we don't carry stay queued.
      if (l.match_status === 'needs_review' && k.expected.sku && !(l.export_hold && !l.export_cleared)) await resolvePart(pool, l.id, { version: l.version, part_sku: k.expected.sku }, 'eval:answer-key');
    }
    after.push(scoreRfq(key, (await getLineViews(pool, { rfqId })).map(toSys)));
    process.stdout.write(`${id} `);
  }
  process.stdout.write('\n');

  const idx = await loadCatalogIndex(pool);
  const sweep = [0.6, 0.7, 0.8, 0.9].map((t) => {
    let accepted = 0;
    let wrong = 0;
    for (const s of sweepLines) {
      const l = s.line;
      const d = decide({ kind: 'description', candidates: l.candidates }, l.match_suggestion, { ref: 'x', rfq_ref: '', request: requestText(l), reason: 'description', candidates: l.candidates, source: l.source }, t, idx);
      if (d.status !== 'auto') continue;
      accepted += 1;
      if (d.sku !== s.want || s.review) wrong += 1;
    }
    return { threshold: t, claude_answers: sweepLines.length, accepted, wrong };
  });

  const tm = cfg.evals.time_model;
  const manual = sum(auto, (s) => tm.manual_minutes_per_rfq + tm.manual_minutes_per_line * s.keyLines);
  const assisted = sum(auto, (s) => tm.assisted_minutes_per_rfq + (s.extracted - s.linesNeedingPerson) * tm.assisted_minutes_per_clean_line + s.linesNeedingPerson * tm.assisted_minutes_per_flagged_line);
  const calls = await pool.query<{ purpose: string; calls: number; input_tokens: number; output_tokens: number; p50: number; p95: number }>(
    `select purpose, count(*)::int as calls, coalesce(sum(input_tokens), 0)::int as input_tokens, coalesce(sum(output_tokens), 0)::int as output_tokens,
            coalesce(percentile_cont(0.5) within group (order by latency_ms), 0)::int as p50, coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::int as p95
       from llm_calls where created_at >= $1 group by purpose order by purpose`,
    [startedAt],
  );
  const flagCodes = [...new Set(after.flatMap((s) => Object.keys(s.flags)))].sort();
  const rows: [string, string, string, string][] = [
    ['Line items found (recall)', ratio(sum(auto, (s) => s.paired), sum(auto, (s) => s.keyLines)), '', '1.00'],
    ['Extra line items (not in the key)', String(sum(auto, (s) => s.extracted - s.paired)), '', '0'],
    ['Quantity read right', ratio(sum(auto, (s) => s.fieldOk.qty), sum(auto, (s) => s.paired)), '', '>= 0.95'],
    ['Unit read right', ratio(sum(auto, (s) => s.fieldOk.uom), sum(auto, (s) => s.paired)), '', '>= 0.95'],
    ['Need-by date read right', ratio(sum(auto, (s) => s.fieldOk.due), sum(auto, (s) => s.paired)), '', '>= 0.95'],
    ['Certs read right', ratio(sum(auto, (s) => s.fieldOk.certs), sum(auto, (s) => s.paired)), '', '>= 0.95'],
    ['Wrong parts placed automatically', String(sum(auto, (s) => s.wrongParts.length)), '', '0'],
    ['Auto-match precision', ratio(sum(auto, (s) => s.autoCorrect), sum(auto, (s) => s.autoMatched)), '', '1.00'],
    ['Lines matched without a person', ratio(sum(auto, (s) => s.autoMatched), sum(auto, (s) => s.paired)), '', 'report'],
    ['Ambiguous or unknown lines sent to a person', `${sum(auto, (s) => s.askedWhenShould)}/${sum(auto, (s) => s.shouldAsk)}`, '', 'all'],
    ['Export lines held', `${sum(auto, (s) => s.heldCaught)}/${sum(auto, (s) => s.heldExpected)}`, '', 'all'],
    ['Held lines priced', String(sum(auto, (s) => s.heldPriced)), '', '0'],
    ['Held line text sent to Claude', String(leaks.length), '', '0'],
    ['Lines priced exactly like the key', '', `${sum(after, (s) => s.priceExact)}/${sum(after, (s) => s.priceChecked)}`, 'all'],
    ['Lines approved by customer rules', String(sum(auto, (s) => s.autoApproved)), '', 'report'],
    ['Customer-rule approvals that were wrong', String(sum(auto, (s) => s.autoApprovedWrong)), '', '0'],
    ['Lines needing a person', `${sum(auto, (s) => s.linesNeedingPerson)}/${sum(auto, (s) => s.extracted)}`, '', 'report'],
  ];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const m = models();
  const llmLabel = base.name === 'oracle' ? 'oracle (answer-key stand-in: tests the machinery, NOT a Claude result)' : `Claude (${m.extract} to read free text, ${m.match} to match parts, ${m.write} to word questions)`;
  const md = [
    `# QuoteDesk eval: ${split} split, ${ids.length} RFQs`,
    '',
    `Run ${new Date().toISOString()}. LLM: ${llmLabel}. Match threshold: ${threshold}. Cache: ${process.env.LLM_CACHE ?? 'on'}.`,
    '',
    '## Headline',
    '',
    '| Metric | Auto | After review | Target |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
    '## Time to quote',
    '',
    `Measured: drafting an RFQ (read, extract, match, price, save, question) took p50 ${pctl(runMs, 0.5)} ms and p95 ${pctl(runMs, 0.95)} ms.`,
    '',
    `Modeled, not measured: about ${manual.toFixed(0)} rep minutes by hand versus ${assisted.toFixed(0)} with QuoteDesk for these ${ids.length} RFQs, using the assumptions in config/quotedesk.yaml (evals.time_model).`,
    '',
    '## Flags after review',
    '',
    '| Flag | Expected | Found | Extra |',
    '| --- | --- | --- | --- |',
    ...flagCodes.map((c) => `| ${c} | ${sum(after, (s) => s.flags[c]?.expected ?? 0)} | ${sum(after, (s) => s.flags[c]?.found ?? 0)} | ${sum(after, (s) => s.flags[c]?.extra ?? 0)} |`),
    '',
    "## Threshold sweep (Claude's stored part matches, re-decided)",
    '',
    '| Threshold | Claude answers | Accepted | Accepted but wrong or should have asked |',
    '| --- | --- | --- | --- |',
    ...sweep.map((s) => `| ${s.threshold} | ${s.claude_answers} | ${s.accepted} | ${s.wrong} |`),
    '',
    '## Per RFQ',
    '',
    '| RFQ | Lines | Found | Matched automatically | Needs a person | Priced like key | Draft ms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...auto.map((s, i) => `| ${s.rfq} | ${s.keyLines} | ${s.paired} | ${s.autoMatched} | ${s.linesNeedingPerson} | ${after[i].priceExact}/${after[i].priceChecked} | ${runMs[i]} |`),
    '',
    '## Problems',
    '',
    ...[
      ...auto.flatMap((s) => s.wrongParts.map((w) => `- ${s.rfq} line ${w.line}: placed ${w.got}, the key says ${w.want ?? 'not a catalog item'}`)),
      ...after.flatMap((s) => s.priceMisses.map((p) => `- ${s.rfq} line ${p.line}: ${p.field} ${p.got}, the key says ${p.want}`)),
      ...leaks.map((l) => `- ${l}: held line text was sent to Claude`),
    ].concat(auto.some((s) => s.wrongParts.length) || after.some((s) => s.priceMisses.length) || leaks.length ? [] : ['None.']),
    '',
    '## Claude calls',
    '',
    '| Purpose | Calls | Input tokens | Output tokens | p50 ms | p95 ms |',
    '| --- | --- | --- | --- | --- | --- |',
    ...(calls.rows.length ? calls.rows.map((c) => `| ${c.purpose} | ${c.calls} | ${c.input_tokens} | ${c.output_tokens} | ${c.p50} | ${c.p95} |`) : ['| none (oracle or fully cached) | 0 | 0 | 0 | 0 | 0 |']),
    '',
  ].join('\n');
  const outDir = path.join('evals', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const name = `${stamp}-${split}-${base.name}`;
  fs.writeFileSync(path.join(outDir, `${name}.md`), md);
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ split, threshold, llm: base.name, headline: rows, sweep, run_ms: runMs, modeled_minutes: { manual, assisted }, auto, after, leaks, calls: calls.rows }, null, 2));
  console.log(md.split('## Flags after review')[0]);
  console.log(`Modeled rep time for these RFQs: ${manual.toFixed(0)} minutes by hand, ${assisted.toFixed(0)} with QuoteDesk (assumptions, not measurements).`);
  console.log(`Report: evals/reports/${name}.md`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
