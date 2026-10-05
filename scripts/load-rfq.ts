// npm run rfq:load -- rfq-03 [--llm oracle] [--eval]
// Loads one synthetic RFQ, runs the pipeline and prints the draft quote.
import { loadEnv } from '@/lib/config';
import { money, shortDate } from '@/lib/format';
import { closePools, dbUrl, getPool } from '@/server/db';
import { ingestFixture } from '@/server/ingest/fixture';
import { defaultDeps, runRfq } from '@/server/pipeline';
import { getRfqView } from '@/server/rfqs';

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const id = args.find((a) => /^rfq-\d{2}$/.test(a));
  if (!id) throw new Error('Usage: npm run rfq:load -- rfq-03 [--llm oracle] [--eval]');
  const llmIdx = args.indexOf('--llm');
  if (llmIdx >= 0) process.env.LLM_MODE = args[llmIdx + 1];
  const pool = getPool(dbUrl(args.includes('--eval') ? 'eval' : 'dev'));
  const { rfqId, created } = await ingestFixture(pool, id);
  console.log(`${created ? 'Loaded' : 'Already loaded'} ${id} as ${rfqId}`);
  const deps = await defaultDeps(pool);
  await runRfq(pool, rfqId, (e) => {
    if (e.type === 'stage') console.log(`- ${e.message}`);
    if (e.type === 'summary') console.log(`  ${e.lines} lines: ${e.matched} matched, ${e.needs_part} need a part, ${e.held} held for export review, ${e.auto_approved} approved by customer rules (${e.asked_claude_about} sent to ${deps.llm.name})`);
  }, deps);
  const v = await getRfqView(pool, rfqId);
  console.log(`\n${v.rfq.subject}\nFrom ${v.rfq.from_name}, ${v.customer?.name} (tier ${v.customer?.tier}). Quote date ${v.rfq.quote_date}.`);
  for (const l of v.lines) {
    const p = l.price;
    const what = l.part ? `${l.part.sku} ${l.part.description}` : `(no part) "${l.requested.part_text || l.requested.description}"`;
    console.log(`\n${String(l.line_no).padStart(2)}. ${what}`);
    console.log(`    ${l.qty ?? '?'} ${l.uom}${l.due_date ? `, need by ${shortDate(l.due_date)}` : ''}${l.certs.length ? `, certs ${l.certs.join('+')}` : ''}  [${l.extraction_method} / ${l.match_method ?? l.match_status}${l.export_hold ? ` / HELD ${l.export_hold}` : ''}]  ${l.status}${l.approved_by?.startsWith('rule:') ? ' by rule' : ''}`);
    if (p) console.log(`    ${p.billed_qty} x ${money(p.unit_cents)} = ${money(p.extended_cents)}${p.rush_fee_cents ? ` + rush ${money(p.rush_fee_cents)}` : ''}${p.min_line_adjust_cents ? ` + min ${money(p.min_line_adjust_cents)}` : ''} -> ${money(p.line_total_cents)}, arrives ${shortDate(p.arrive_date)}`);
    for (const f of l.flags) console.log(`    ${f.severity.padEnd(5)} ${f.code}: ${f.message}`);
  }
  if (v.question) console.log(`\nQuestion for the buyer (${v.question.drafted_by}):\n${v.question.body}`);
  console.log(`\nTotal ${money(v.totals.total_cents)}, margin ${(v.totals.margin_bps / 100).toFixed(1)}%. Run ${v.rfq.run_ms} ms. Claude stand-in: ${deps.llm.name}.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePools());
