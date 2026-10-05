// Runs one RFQ through the stages: read -> extract -> match -> price and check -> save -> customer rules ->
// buyer question. Lines are saved together at the end, in one transaction, so a failed run leaves nothing half done.
import type { Pool } from 'pg';
import { customerById, customerRules, loadConfig, loadEnv } from '@/lib/config';
import type { ExportHold, LLM } from '@/lib/types';
import { autoApproveRule } from '@/server/automation/rules';
import { withTx } from '@/server/db';
import { extractRfq } from '@/server/extract/index';
import { loadDocs } from '@/server/ingest/fixture';
import { getLLM, LLMUnavailableError, ModelOutputError, RefusalError } from '@/server/llm/client';
import { VERSION as MATCH_VERSION } from '@/server/llm/prompts/match.v1';
import { autoApprove, getLineViews, HttpError, insertLine, loadEvalContext, loadParts, type LineView, type NewLine } from '@/server/lines/service';
import { matchLines, parseThreshold } from '@/server/match/index';
import { buildIndex, exactLookup, type CatalogIndex } from '@/server/match/rules';
import { draftQuestion } from '@/server/questions/index';

export type PipelineEvent =
  | { type: 'stage'; stage: 'read' | 'extract' | 'match' | 'price' | 'save' | 'question'; message: string }
  | { type: 'summary'; lines: number; matched: number; needs_part: number; held: number; asked_claude_about: number; auto_approved: number }
  | { type: 'line'; line: LineView }
  | { type: 'done'; status: string; run_ms: number }
  | { type: 'error'; message: string };

export interface Deps {
  llm: LLM;
  threshold: number;
}

export async function defaultDeps(pool: Pool): Promise<Deps> {
  loadEnv();
  return { llm: await getLLM(pool), threshold: parseThreshold(process.env.MATCH_THRESHOLD) };
}

export function repActor(): string {
  return `rep:${loadConfig().distributor.rep.id}`;
}

export async function loadCatalogIndex(pool: Pool): Promise<CatalogIndex> {
  const cfg = loadConfig();
  const parts = [...(await loadParts(pool)).values()];
  const xref = await pool.query<{ customer_id: string; customer_pn: string; sku: string }>('select customer_id, customer_pn, sku from customer_xref');
  return buildIndex(parts, xref.rows, { synonyms: cfg.matching.synonyms, stop: cfg.matching.stop_words });
}

export async function runRfq(pool: Pool, rfqId: string, emit: (e: PipelineEvent) => void | Promise<void>, deps: Deps): Promise<void> {
  const started = Date.now();
  const r = await pool.query<{ fixture_id: string; customer_id: string | null; from_email: string; subject: string; quote_date: string; status: string }>('select fixture_id, customer_id, from_email, subject, quote_date, status from rfqs where id = $1', [rfqId]);
  if (!r.rowCount) throw new HttpError(404, 'That RFQ has not been loaded.');
  const rfq = r.rows[0];
  if (rfq.status === 'drafted' || rfq.status === 'quoted') {
    await emit({ type: 'done', status: rfq.status, run_ms: 0 });
    return;
  }
  try {
    if (!rfq.customer_id) throw new HttpError(422, "QuoteDesk couldn't tell which customer sent this RFQ. Add their email domain to config/quotedesk.yaml.");
    await pool.query('update rfqs set run_started_at = now() where id = $1', [rfqId]);
    const cfg = loadConfig();
    const customer = customerById(rfq.customer_id, cfg);
    const docs = await loadDocs(pool, rfqId);
    const attachments = docs.filter((d) => d.kind !== 'body').length;
    await emit({ type: 'stage', stage: 'read', message: attachments ? `Reading ${attachments === 1 ? 'the attachment' : `${attachments} attachments`} and the email` : 'Reading the email' });
    const idx = await loadCatalogIndex(pool);

    await emit({ type: 'stage', stage: 'extract', message: 'Pulling out line items' });
    const ex = await extractRfq({ rfqRef: rfq.fixture_id, from: rfq.from_email, subject: rfq.subject, quoteDate: rfq.quote_date, docs, customer, cfg, findPart: (s) => exactLookup(s, customer.id, idx)?.skus[0] ?? null, llm: deps.llm });
    if (!ex.lines.length) throw new HttpError(422, 'No line items were found in this RFQ. Open the attachments and enter the lines by hand.');

    await emit({ type: 'stage', stage: 'match', message: `Matching ${ex.lines.length} lines to the catalog` });
    const holds: (ExportHold | null)[] = ex.lines.map((l) => (l.export_marked ? 'marked' : l.screened_term ? 'screened' : null));
    const m = await matchLines(ex.lines.map((line, i) => ({ line, held: Boolean(holds[i]) })), { rfqRef: rfq.fixture_id, customerId: customer.id, idx, llm: deps.llm, threshold: deps.threshold });

    await emit({ type: 'stage', stage: 'price', message: 'Pricing and checking lead times' });
    const ctx = await loadEvalContext(pool, rfqId);
    const rules = customerRules(customer);
    const drafts: NewLine[] = ex.lines.map((l, i) => {
      const mm = m.matches[i];
      let sku = mm.sku;
      let requestedSku: string | null = null;
      const asked = sku ? ctx.parts.get(sku) : undefined;
      if (asked?.status === 'obsolete' && asked.superseded_by && rules.substitutes === 'allow') {
        requestedSku = asked.sku;
        sku = asked.superseded_by;
      }
      const part = sku ? ctx.parts.get(sku) : undefined;
      return {
        line_no: i + 1,
        source: l.source,
        extraction_method: l.method,
        notes: l.notes,
        requested: l.requested,
        qty: l.qty,
        uom: l.uom,
        due_date: l.due_date,
        certs: l.certs,
        certs_unclear: l.certs_unclear,
        part_sku: sku,
        requested_sku: requestedSku,
        match_status: mm.status,
        match_method: mm.method,
        match_confidence: mm.confidence,
        match_evidence: mm.evidence,
        match_suggestion: mm.suggestion,
        candidates: mm.candidates,
        claude_said_none: mm.claude_said_none,
        export_hold: holds[i] ?? (part?.export_controlled ? 'catalog' : null),
        export_term: l.screened_term,
        export_cleared: null,
        price_override_cents: null,
        price_override_reason: null,
        prompt_versions: [...(l.method === 'claude' && ex.prompt_version ? [ex.prompt_version] : []), ...(mm.suggestion ? [deps.llm.name === 'oracle' ? 'oracle' : MATCH_VERSION] : [])],
      };
    });

    await emit({ type: 'stage', stage: 'save', message: 'Saving the draft quote' });
    let autoApproved = 0;
    const ids = await withTx(pool, async (c) => {
      const out: string[] = [];
      for (const d of drafts) {
        const saved = await insertLine(c, rfqId, d, ctx, 'system');
        out.push(saved.id);
        const rule = autoApproveRule(rules, { status: 'draft', export_hold: d.export_hold, match_method: d.match_method, part: d.part_sku ? ctx.parts.get(d.part_sku) ?? null : null, price: saved.price, flags: saved.flags });
        if (rule) {
          await autoApprove(c, saved.id, customer.id, rule);
          autoApproved += 1;
        }
      }
      await c.query(`update rfqs set status = 'drafted', defaults = $2, run_ms = $3 where id = $1`, [rfqId, JSON.stringify(ex.defaults), Date.now() - started]);
      return out;
    });
    await emit({ type: 'summary', lines: drafts.length, matched: drafts.filter((d) => d.match_status === 'auto').length, needs_part: drafts.filter((d) => d.match_status === 'needs_review').length, held: drafts.filter((d) => d.export_hold).length, asked_claude_about: m.asked, auto_approved: autoApproved });
    for (const v of await getLineViews(pool, { ids })) await emit({ type: 'line', line: v });

    if (drafts.some((d) => d.qty === null || d.due_date === null || d.certs_unclear)) {
      await emit({ type: 'stage', stage: 'question', message: 'Drafting a question for the buyer' });
      await draftQuestion(pool, rfqId, deps.llm, 'system');
    }
    const runMs = Date.now() - started;
    await pool.query('update rfqs set run_ms = $2 where id = $1', [rfqId, runMs]);
    await emit({ type: 'done', status: 'drafted', run_ms: runMs });
  } catch (err) {
    await pool.query(`update rfqs set status = 'failed' where id = $1 and status = 'ingested'`, [rfqId]).catch(() => undefined);
    await emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

/** Maps errors to JSON responses: HttpError keeps its status, bad bodies are 400, Claude problems 502/503. */
export function jsonError(err: unknown): Response {
  if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof ModelOutputError || err instanceof RefusalError) return Response.json({ error: err.message }, { status: 502 });
  if (err instanceof LLMUnavailableError) return Response.json({ error: err.message }, { status: 503 });
  if (err && typeof err === 'object' && 'issues' in err) return Response.json({ error: 'The request body is not valid.', issues: (err as { issues: unknown }).issues }, { status: 400 });
  console.error(err);
  return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
}
