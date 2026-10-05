// The only code that writes quote_lines and line_flags. Every change locks the line, checks the version the
// rep saw, writes the change and exactly one audit row in one transaction, and re-prices the line with
// evaluateLine(). Prices only ever come from code.
import type { Pool, PoolClient } from 'pg';
import { customerById, customerRules, loadConfig } from '@/lib/config';
import type { Candidate, Cert, ExportHold, Flag, LineStatus, MatchAnswer, MatchMethod, MatchStatus, MissingField, Part, PriceResult, Requested, SourceRef, Uom } from '@/lib/types';
import { withTx, type Queryable } from '@/server/db';
import { audit } from './audit';
import { evaluateLine, type EvalContext, type LineState } from './evaluate';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface LineRow {
  id: string;
  rfq_id: string;
  line_no: number;
  source: SourceRef;
  requested: Requested;
  extraction_method: 'rule' | 'claude';
  notes: string[];
  qty: number | null;
  uom: Uom;
  due_date: string | null;
  certs: Cert[];
  certs_unclear: boolean;
  missing: MissingField[];
  part_sku: string | null;
  requested_sku: string | null;
  match_method: MatchMethod | null;
  match_status: MatchStatus;
  match_confidence: number | null;
  match_evidence: { signal: string; value: string }[];
  match_suggestion: MatchAnswer | null;
  candidates: Candidate[];
  claude_said_none: boolean;
  not_carried: boolean;
  export_hold: ExportHold | null;
  export_term: string | null;
  export_cleared: { by: string; reason: string; at: string } | null;
  price: PriceResult | null;
  price_override_cents: number | null;
  price_override_reason: string | null;
  status: LineStatus;
  status_reason: string | null;
  approved_by: string | null;
  prompt_versions: string[];
  version: number;
}

export async function loadParts(db: Queryable): Promise<Map<string, Part & { supplier_name: string }>> {
  const res = await db.query<Part & { supplier_name: string }>(
    `select p.sku, p.category, p.description, p.mfr, p.mfr_part, p.supplier_id, p.supplier_part, p.uom, p.pack_qty, p.supplier_moq, p.cost_cents, p.stock_qty,
            p.lead_time_days, p.status, p.superseded_by, p.export_controlled, p.certs, p.aliases, s.name as supplier_name
       from parts p join suppliers s on s.id = p.supplier_id`,
  );
  return new Map(res.rows.map((p) => [p.sku, p]));
}

export async function loadEvalContext(db: Queryable, rfqId: string): Promise<EvalContext & { customerId: string; parts: Map<string, Part & { supplier_name: string }> }> {
  const r = await db.query<{ customer_id: string | null; quote_date: string }>('select customer_id, quote_date from rfqs where id = $1', [rfqId]);
  if (!r.rowCount) throw new HttpError(404, 'That RFQ has not been loaded.');
  if (!r.rows[0].customer_id) throw new HttpError(422, "QuoteDesk couldn't tell which customer sent this RFQ. Add their email domain to config/quotedesk.yaml.");
  const cfg = loadConfig();
  const c = customerById(r.rows[0].customer_id, cfg);
  return { customerId: c.id, parts: await loadParts(db), tier: c.tier, rules: cfg.pricing, customerRules: customerRules(c), holidays: cfg.distributor.holidays, quote_date: r.rows[0].quote_date };
}

function stateOf(r: LineRow): LineState {
  return {
    requested: r.requested,
    qty: r.qty,
    uom: r.uom,
    due_date: r.due_date,
    certs: r.certs,
    certs_unclear: r.certs_unclear,
    part_sku: r.part_sku,
    requested_sku: r.requested_sku,
    match_status: r.match_status,
    claude_said_none: r.claude_said_none,
    export_hold: r.export_hold,
    export_term: r.export_term,
    export_cleared: r.export_cleared ? { by: r.export_cleared.by, reason: r.export_cleared.reason } : null,
    price_override_cents: r.price_override_cents,
    price_override_reason: r.price_override_reason,
  };
}

const SNAP = ['part_sku', 'qty', 'uom', 'due_date', 'certs', 'price_override_cents', 'price_override_reason', 'status', 'export_hold'] as const;
function snapshot(r: Pick<LineRow, (typeof SNAP)[number] | 'price'>): Record<string, unknown> {
  return { ...Object.fromEntries(SNAP.map((k) => [k, r[k]])), line_total_cents: r.price?.line_total_cents ?? null };
}

async function writeFlags(c: Queryable, lineId: string, flags: Flag[], keepOverrides: boolean): Promise<void> {
  const kept = keepOverrides ? await c.query<{ code: string; override_reason: string }>('select code, override_reason from line_flags where line_id = $1 and override_reason is not null', [lineId]) : { rows: [] };
  const overrides = new Map(kept.rows.map((r) => [r.code, r.override_reason]));
  await c.query('delete from line_flags where line_id = $1', [lineId]);
  for (const f of flags) {
    await c.query('insert into line_flags (line_id, code, severity, message, evidence, override_reason) values ($1,$2,$3,$4,$5,$6)', [lineId, f.code, f.severity, f.message, JSON.stringify(f.evidence), overrides.get(f.code) ?? null]);
  }
}

export interface NewLine extends LineState {
  line_no: number;
  source: SourceRef;
  extraction_method: 'rule' | 'claude';
  notes: string[];
  match_method: MatchMethod | null;
  match_confidence: number | null;
  match_evidence: { signal: string; value: string }[];
  match_suggestion: MatchAnswer | null;
  candidates: Candidate[];
  prompt_versions: string[];
}

/** Creates a line with its price and flags, and its 'created' audit row. */
export async function insertLine(c: PoolClient, rfqId: string, n: NewLine, ctx: EvalContext, actor: string): Promise<{ id: string; price: PriceResult | null; flags: Flag[] }> {
  const ev = evaluateLine(n, ctx);
  const notes = [...n.notes, ...(ev.unit_note ? [ev.unit_note] : [])];
  const res = await c.query<{ id: string }>(
    `insert into quote_lines (rfq_id, line_no, source, requested, extraction_method, notes, qty, uom, due_date, certs, certs_unclear, missing, part_sku, requested_sku,
       match_method, match_status, match_confidence, match_evidence, match_suggestion, candidates, claude_said_none, export_hold, export_term, price, prompt_versions)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) returning id`,
    [rfqId, n.line_no, JSON.stringify(n.source), JSON.stringify(n.requested), n.extraction_method, notes, n.qty, n.uom, n.due_date, n.certs, n.certs_unclear, ev.missing, n.part_sku, n.requested_sku,
      n.match_method, n.match_status, n.match_confidence, JSON.stringify(n.match_evidence), n.match_suggestion ? JSON.stringify(n.match_suggestion) : null, JSON.stringify(n.candidates), n.claude_said_none, n.export_hold, n.export_term, ev.price ? JSON.stringify(ev.price) : null, n.prompt_versions],
  );
  const id = res.rows[0].id;
  await writeFlags(c, id, ev.flags, false);
  await audit(c, {
    subject_type: 'line', subject_id: id, version: 1, actor, action: 'created',
    after: { line_no: n.line_no, extraction: n.extraction_method, match: n.match_method ?? 'none', match_status: n.match_status, confidence: n.match_confidence, ...snapshot({ ...n, status: 'draft', price: ev.price }), flags: ev.flags.map((f) => f.code) },
  });
  return { id, price: ev.price, flags: ev.flags };
}

async function lockLine(c: PoolClient, id: string, version: number): Promise<LineRow> {
  const res = await c.query<LineRow>('select * from quote_lines where id = $1 for update', [id]);
  const row = res.rows[0];
  if (!row) throw new HttpError(404, 'That line no longer exists.');
  if (row.version !== version) throw new HttpError(409, 'This line changed since you loaded it. Reload to see the latest version.');
  return row;
}

/** Saves a new state, re-prices it and replaces its flags. */
async function save(c: PoolClient, row: LineRow, next: LineState, extra: { match_method?: MatchMethod | null; status?: LineStatus; status_reason?: string | null; approved_by?: string | null; not_carried?: boolean; export_cleared?: LineRow['export_cleared'] }, ctx: EvalContext, keepOverrides: boolean): Promise<LineRow> {
  const ev = evaluateLine(next, ctx);
  const res = await c.query<LineRow>(
    `update quote_lines set qty = $2, uom = $3, due_date = $4, certs = $5, certs_unclear = $6, missing = $7, part_sku = $8, requested_sku = $9, match_method = $10,
       match_status = $11, export_hold = $12, export_cleared = $13, price = $14, price_override_cents = $15, price_override_reason = $16, status = $17,
       status_reason = $18, approved_by = $19, not_carried = $20, version = version + 1, updated_at = now()
     where id = $1 returning *`,
    [row.id, next.qty, next.uom, next.due_date, next.certs, next.certs_unclear, ev.missing, next.part_sku, next.requested_sku, extra.match_method !== undefined ? extra.match_method : row.match_method,
      next.match_status, next.export_hold, JSON.stringify(extra.export_cleared !== undefined ? extra.export_cleared : row.export_cleared), ev.price ? JSON.stringify(ev.price) : null, next.price_override_cents, next.price_override_reason,
      extra.status ?? row.status, extra.status_reason !== undefined ? extra.status_reason : row.status_reason, extra.approved_by !== undefined ? extra.approved_by : row.approved_by, extra.not_carried ?? row.not_carried],
  );
  await writeFlags(c, row.id, ev.flags, keepOverrides);
  return res.rows[0];
}

/** Export holds that come from the catalog follow the part; holds the buyer or the screening set stay. */
function holdFor(next: LineState, part: Part | undefined): ExportHold | null {
  if (next.export_hold && next.export_hold !== 'catalog') return next.export_hold;
  return part?.export_controlled ? 'catalog' : null;
}

export interface LinePatch {
  version: number;
  part_sku?: string;
  qty?: number;
  uom?: Uom;
  due_date?: string | null;
  certs?: Cert[];
  price_override_cents?: number | null;
  price_override_reason?: string;
}

export async function editLine(pool: Pool, id: string, patch: LinePatch, actor: string): Promise<void> {
  await withTx(pool, async (c) => {
    const row = await lockLine(c, id, patch.version);
    if (row.status !== 'draft') throw new HttpError(409, 'Only draft lines can be edited. Reopen the line first.');
    const ctx = await loadEvalContext(c, row.rfq_id);
    const next = stateOf(row);
    let matchMethod: MatchMethod | null | undefined;
    if (patch.part_sku !== undefined && patch.part_sku !== row.part_sku) {
      const part = ctx.parts.get(patch.part_sku);
      if (!part) throw new HttpError(422, `${patch.part_sku} isn't in the catalog.`);
      const old = row.part_sku ? ctx.parts.get(row.part_sku) : undefined;
      next.part_sku = part.sku;
      // Swapping an obsolete part for its listed replacement keeps what the buyer asked for, so the email can say so.
      next.requested_sku = old?.status === 'obsolete' && old.superseded_by === part.sku ? old.sku : row.requested_sku && ctx.parts.get(row.requested_sku)?.superseded_by === part.sku ? row.requested_sku : null;
      next.match_status = row.match_status === 'needs_review' ? 'resolved' : row.match_status;
      next.export_hold = holdFor(next, part);
      matchMethod = 'rep';
    }
    if (patch.qty !== undefined) next.qty = patch.qty;
    if (patch.uom !== undefined) next.uom = patch.uom;
    if (patch.due_date !== undefined) next.due_date = patch.due_date;
    if (patch.certs !== undefined) {
      next.certs = [...new Set(patch.certs)].sort() as Cert[];
      next.certs_unclear = false;
    }
    if (patch.price_override_cents !== undefined) {
      if (patch.price_override_cents === null) {
        next.price_override_cents = null;
        next.price_override_reason = null;
      } else {
        const reason = patch.price_override_reason?.trim() || row.price_override_reason;
        if (!reason) throw new HttpError(422, 'Say why the unit price is set by hand. The reason goes in the history.');
        next.price_override_cents = patch.price_override_cents;
        next.price_override_reason = reason;
      }
    } else if (patch.price_override_reason !== undefined && row.price_override_cents) next.price_override_reason = patch.price_override_reason;
    const before = snapshot(row);
    const changed = JSON.stringify(stateOf(row)) !== JSON.stringify(next);
    if (!changed) return;
    const saved = await save(c, row, next, { match_method: matchMethod }, ctx, false); // an edit needs fresh reasons for any blocking flags
    await audit(c, { subject_type: 'line', subject_id: id, version: saved.version, actor, action: 'edited', before, after: snapshot(saved) });
  });
}

/** From "Needs a part": the rep picks a part, or says it isn't something we carry. */
export async function resolvePart(pool: Pool, id: string, body: { version: number; part_sku: string } | { version: number; not_carried: true }, actor: string): Promise<void> {
  await withTx(pool, async (c) => {
    const row = await lockLine(c, id, body.version);
    if (row.status !== 'draft' || row.match_status !== 'needs_review') throw new HttpError(409, 'This line already has a part. Edit it instead.');
    const ctx = await loadEvalContext(c, row.rfq_id);
    const next = stateOf(row);
    next.match_status = 'resolved';
    if ('not_carried' in body) {
      const saved = await save(c, row, next, { match_method: 'rep', status: 'rejected', status_reason: 'Not a catalog item', not_carried: true }, ctx, false);
      await audit(c, { subject_type: 'line', subject_id: id, version: saved.version, actor, action: 'not_carried', before: snapshot(row), after: snapshot(saved), reason: 'Not a catalog item' });
      return;
    }
    const part = ctx.parts.get(body.part_sku);
    if (!part) throw new HttpError(422, `${body.part_sku} isn't in the catalog.`);
    next.part_sku = part.sku;
    next.requested_sku = null;
    next.export_hold = holdFor(next, part);
    const saved = await save(c, row, next, { match_method: 'rep' }, ctx, false);
    await audit(c, { subject_type: 'line', subject_id: id, version: saved.version, actor, action: 'part_chosen', before: snapshot(row), after: snapshot(saved), reason: row.match_suggestion ? `Claude had suggested ${row.match_suggestion.sku} at ${row.match_suggestion.confidence}` : null });
  });
}

export async function approveLine(pool: Pool, id: string, body: { version: number; override_reason?: string }, actor: string): Promise<void> {
  await withTx(pool, async (c) => {
    const row = await lockLine(c, id, body.version);
    if (row.status !== 'draft') throw new HttpError(409, 'Only draft lines can be approved.');
    if (row.export_hold && !row.export_cleared) throw new HttpError(409, 'This line is held for export review. A person has to clear the hold before it can be priced or approved.');
    if (!row.part_sku) throw new HttpError(422, 'Pick a part before approving this line.');
    if (!row.price) {
      const ctx = await loadEvalContext(c, row.rfq_id);
      throw new HttpError(422, ctx.parts.get(row.part_sku)?.status === 'obsolete' ? 'This part is obsolete. Use its replacement or reject the line.' : 'Add a quantity before approving this line.');
    }
    const blocking = await c.query<{ code: string }>(`select code from line_flags where line_id = $1 and severity = 'block' and override_reason is null`, [id]);
    if (blocking.rowCount && !body.override_reason) throw new HttpError(422, `This line has a blocking flag (${blocking.rows.map((r) => r.code).join(', ')}). Give a reason to approve it anyway.`);
    if (blocking.rowCount) await c.query(`update line_flags set override_reason = $2 where line_id = $1 and severity = 'block' and override_reason is null`, [id, body.override_reason]);
    const res = await c.query<LineRow>(`update quote_lines set status = 'approved', approved_by = $2, status_reason = null, version = version + 1, updated_at = now() where id = $1 returning *`, [id, actor]);
    await audit(c, { subject_type: 'line', subject_id: id, version: res.rows[0].version, actor, action: 'approved', before: { status: row.status }, after: { status: 'approved', line_total_cents: row.price.line_total_cents }, reason: body.override_reason ?? null });
  });
}

/** Approval by a customer's automation rule. Runs inside the pipeline's transaction. */
export async function autoApprove(c: PoolClient, id: string, customerId: string, ruleName: string): Promise<void> {
  const actor = `rule:${customerId}/${ruleName}`;
  const res = await c.query<LineRow>(`update quote_lines set status = 'approved', approved_by = $2, version = version + 1, updated_at = now() where id = $1 and status = 'draft' returning *`, [id, actor]);
  if (res.rowCount) await audit(c, { subject_type: 'line', subject_id: id, version: res.rows[0].version, actor, action: 'approved', before: { status: 'draft' }, after: { status: 'approved', line_total_cents: res.rows[0].price?.line_total_cents ?? null }, reason: `Customer rule: ${ruleName}` });
}

export async function rejectLine(pool: Pool, id: string, body: { version: number; reason: string }, actor: string): Promise<void> {
  await withTx(pool, async (c) => {
    const row = await lockLine(c, id, body.version);
    if (row.status !== 'draft') throw new HttpError(409, 'Only draft lines can be rejected.');
    const res = await c.query<LineRow>(`update quote_lines set status = 'rejected', status_reason = $2, version = version + 1, updated_at = now() where id = $1 returning *`, [id, body.reason]);
    await audit(c, { subject_type: 'line', subject_id: id, version: res.rows[0].version, actor, action: 'rejected', before: { status: row.status }, after: { status: 'rejected' }, reason: body.reason });
  });
}

/** Back to draft. Reasons given for blocking flags stay; editing the line clears them. */
export async function reopenLine(pool: Pool, id: string, body: { version: number }, actor: string): Promise<void> {
  await withTx(pool, async (c) => {
    const row = await lockLine(c, id, body.version);
    if (row.status === 'draft') throw new HttpError(409, 'This line is already a draft.');
    if (row.not_carried) {
      const ctx = await loadEvalContext(c, row.rfq_id);
      const next = { ...stateOf(row), match_status: 'needs_review' as const };
      const saved = await save(c, row, next, { status: 'draft', status_reason: null, approved_by: null, not_carried: false }, ctx, true);
      await audit(c, { subject_type: 'line', subject_id: id, version: saved.version, actor, action: 'reopened', before: { status: row.status }, after: { status: 'draft' } });
      return;
    }
    const res = await c.query<LineRow>(`update quote_lines set status = 'draft', status_reason = null, approved_by = null, version = version + 1, updated_at = now() where id = $1 returning *`, [id]);
    await audit(c, { subject_type: 'line', subject_id: id, version: res.rows[0].version, actor, action: 'reopened', before: { status: row.status }, after: { status: 'draft' } });
  });
}

/** A person clears an export hold, by name and with a reason. Only then is the line priced. */
export async function clearExport(pool: Pool, id: string, body: { version: number; reviewer: string; reason: string }, actor: string): Promise<void> {
  await withTx(pool, async (c) => {
    const row = await lockLine(c, id, body.version);
    if (!row.export_hold || row.export_cleared) throw new HttpError(409, 'This line has no export hold to clear.');
    if (row.status !== 'draft') throw new HttpError(409, 'Reopen the line before clearing its hold.');
    const ctx = await loadEvalContext(c, row.rfq_id);
    const cleared = { by: body.reviewer, reason: body.reason, at: new Date().toISOString() };
    const next = { ...stateOf(row), export_cleared: { by: body.reviewer, reason: body.reason } };
    const saved = await save(c, row, next, { export_cleared: cleared }, ctx, false);
    await audit(c, { subject_type: 'line', subject_id: id, version: saved.version, actor, action: 'export_cleared', before: { export_hold: row.export_hold }, after: { export_cleared: cleared, line_total_cents: saved.price?.line_total_cents ?? null }, reason: body.reason });
  });
}

// ---------------------------------------------------------------- read models

export interface FlagView extends Flag {
  override_reason: string | null;
}

export interface LineView extends LineRow {
  part: (Part & { supplier_name: string }) | null;
  requested_part: { sku: string; description: string; mfr_part: string } | null;
  replacement: { sku: string; description: string; stock_qty: number } | null;
  flags: FlagView[];
}

export async function getLineViews(db: Queryable, filter: { rfqId: string } | { ids: string[] }): Promise<LineView[]> {
  const byIds = 'ids' in filter;
  const rows = await db.query<LineRow>(`select * from quote_lines where ${byIds ? 'id = any($1::uuid[])' : 'rfq_id = $1'} order by line_no`, [byIds ? filter.ids : filter.rfqId]);
  const flags = await db.query<FlagView & { line_id: string }>(`select line_id, code, severity, message, evidence, override_reason from line_flags where line_id = any($1::uuid[]) order by id`, [rows.rows.map((r) => r.id)]);
  const parts = await loadParts(db);
  return rows.rows.map((r) => {
    const part = r.part_sku ? parts.get(r.part_sku) ?? null : null;
    const asked = r.requested_sku ? parts.get(r.requested_sku) : undefined;
    const repl = part?.status === 'obsolete' && part.superseded_by ? parts.get(part.superseded_by) : undefined;
    return {
      ...r,
      part,
      requested_part: asked ? { sku: asked.sku, description: asked.description, mfr_part: asked.mfr_part } : null,
      replacement: repl ? { sku: repl.sku, description: repl.description, stock_qty: repl.stock_qty } : null,
      flags: flags.rows.filter((f) => f.line_id === r.id).map(({ line_id: _drop, ...f }) => f),
    };
  });
}

export async function getLineHistory(db: Queryable, id: string) {
  const res = await db.query<{ id: string; version: number | null; actor: string; action: string; before: unknown; after: unknown; reason: string | null; created_at: Date }>(
    `select id, version, actor, action, before, after, reason, created_at from audit_events where subject_type = 'line' and subject_id = $1 order by id desc`,
    [id],
  );
  return res.rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
}

/** "Why this line": where it came from in the email, how the part was matched, and how the price was built. */
export async function getLineSources(db: Queryable, id: string) {
  const res = await db.query<LineRow>('select * from quote_lines where id = $1', [id]);
  const line = res.rows[0];
  if (!line) throw new HttpError(404, 'That line no longer exists.');
  const doc = await db.query<{ kind: string; parsed: { sheets?: { name: string; rows: { row: number; cells: string[] }[] }[]; pdf?: { lines: { page: number; line: number; text: string }[] }; text?: string } }>(
    'select kind, parsed from rfq_documents where rfq_id = $1 and filename = $2',
    [line.rfq_id, line.source.doc],
  );
  const d = doc.rows[0];
  let context: { kind: 'table'; header: string[]; row: string[] } | { kind: 'text'; before: string; quote: string; after: string } | null = null;
  if (d?.kind === 'xlsx' && line.source.sheet) {
    const rows = d.parsed.sheets?.find((s) => s.name === line.source.sheet)?.rows ?? [];
    const row = rows.find((r) => r.row === line.source.row);
    const header = [...rows].reverse().find((r) => r.row < (line.source.row ?? 0) && r.cells.some((c) => /qty|quantity/i.test(c)));
    if (row) context = { kind: 'table', header: header?.cells ?? [], row: row.cells };
  } else if (d) {
    const text = d.kind === 'pdf' ? (d.parsed.pdf?.lines ?? []).map((l) => l.text).join('\n') : d.parsed.text ?? '';
    const at = text.indexOf(line.source.quote);
    context = at >= 0 ? { kind: 'text', before: text.slice(Math.max(0, at - 160), at), quote: line.source.quote, after: text.slice(at + line.source.quote.length, at + line.source.quote.length + 160) } : { kind: 'text', before: '', quote: line.source.quote, after: '' };
  }
  return { line_no: line.line_no, source: line.source, requested: line.requested, extraction_method: line.extraction_method, notes: line.notes, context, match: { method: line.match_method, status: line.match_status, confidence: line.match_confidence, evidence: line.match_evidence, suggestion: line.match_suggestion, candidates: line.candidates, claude_said_none: line.claude_said_none }, export: { hold: line.export_hold, term: line.export_term, cleared: line.export_cleared }, price: line.price, prompt_versions: line.prompt_versions };
}
