// The question back to the buyer when a line is missing a quantity, a need-by date or which certs they need.
// Code decides what's missing; Claude only words the email. A draft that mentions prices or skips a line
// falls back to the template. Lines held for export review are never included, so they never reach Claude.
import type { Pool } from 'pg';
import { loadConfig } from '@/lib/config';
import type { LLM, MissingField, QuestionOutput, QuestionRequest, Requested } from '@/lib/types';
import { withTx } from '@/server/db';
import { audit } from '@/server/lines/audit';
import { HttpError } from '@/server/lines/service';
import { templateQuestion } from './template';

export function buyerWords(r: Requested): string {
  const w = [r.part_text, r.description].filter(Boolean).join(', ');
  return w.length > 80 ? `${w.slice(0, 77)}...` : w;
}

export function questionProblems(out: QuestionOutput, req: QuestionRequest): string[] {
  const problems: string[] = [];
  for (const a of req.asks) if (!new RegExp(`\\bline\\s+${a.line_no}\\b`, 'i').test(out.body)) problems.push(`doesn't mention line ${a.line_no}`);
  if (/\$|\bprice[sd]?\b|\bpricing\b|\bcost\b|\bUSD\b/i.test(out.body)) problems.push('mentions prices');
  if (out.body.length > 1500) problems.push('too long');
  return problems;
}

export async function draftQuestion(pool: Pool, rfqId: string, llm: LLM, actor: string): Promise<{ drafted_by: string; problems: string[] } | null> {
  const rfq = await pool.query<{ subject: string; from_name: string }>('select subject, from_name from rfqs where id = $1', [rfqId]);
  if (!rfq.rowCount) throw new HttpError(404, 'That RFQ has not been loaded.');
  const lines = await pool.query<{ id: string; line_no: number; requested: Requested; missing: MissingField[] }>(
    `select id, line_no, requested, missing from quote_lines where rfq_id = $1 and status <> 'rejected' and cardinality(missing) > 0 and (export_hold is null or export_cleared is not null) order by line_no`,
    [rfqId],
  );
  if (!lines.rowCount) return null;
  const cfg = loadConfig();
  const req: QuestionRequest = {
    rfq_ref: rfqId,
    buyer_first_name: rfq.rows[0].from_name.split(' ')[0],
    rep_first_name: cfg.distributor.rep.name.split(' ')[0],
    rfq_subject: rfq.rows[0].subject,
    asks: lines.rows.map((l) => ({ line_no: l.line_no, buyer_words: buyerWords(l.requested), fields: l.missing })),
  };
  let out: QuestionOutput = templateQuestion(req);
  let draftedBy = 'template';
  let problems: string[] = [];
  try {
    const drafted = await llm.question(req);
    problems = questionProblems(drafted, req);
    if (!problems.length) {
      out = { subject: drafted.subject, body: drafted.body };
      draftedBy = drafted.meta.promptVersion === 'oracle' ? 'template' : `claude:${drafted.meta.promptVersion}`;
    }
  } catch (err) {
    problems = [err instanceof Error ? err.message : String(err)];
  }
  await withTx(pool, async (c) => {
    const res = await c.query<{ id: string; version: number }>(
      `insert into buyer_questions (rfq_id, asks, subject, body, drafted_by) values ($1,$2,$3,$4,$5)
       on conflict (rfq_id) do update set asks = excluded.asks, subject = excluded.subject, body = excluded.body, drafted_by = excluded.drafted_by,
         status = 'draft', version = buyer_questions.version + 1, updated_at = now()
       returning id, version`,
      [rfqId, JSON.stringify(req.asks), out.subject, out.body, draftedBy],
    );
    await audit(c, { subject_type: 'question', subject_id: res.rows[0].id, version: res.rows[0].version, actor, action: 'drafted', after: { drafted_by: draftedBy, asks: req.asks.map((a) => `line ${a.line_no}: ${a.fields.join(', ')}`), problems } });
  });
  return { drafted_by: draftedBy, problems };
}

export async function editQuestion(pool: Pool, rfqId: string, patch: { version: number; subject?: string; body?: string; status?: 'sent' }, actor: string): Promise<void> {
  await withTx(pool, async (c) => {
    const q = await c.query<{ id: string; version: number; subject: string; body: string; status: string }>('select id, version, subject, body, status from buyer_questions where rfq_id = $1 for update', [rfqId]);
    const row = q.rows[0];
    if (!row) throw new HttpError(404, 'This RFQ has no question for the buyer.');
    if (row.version !== patch.version) throw new HttpError(409, 'The question changed since you loaded it. Reload to see the latest version.');
    const next = { subject: patch.subject ?? row.subject, body: patch.body ?? row.body, status: patch.status ?? row.status };
    await c.query('update buyer_questions set subject = $2, body = $3, status = $4, version = version + 1, updated_at = now() where id = $1', [row.id, next.subject, next.body, next.status]);
    await audit(c, { subject_type: 'question', subject_id: row.id, version: row.version + 1, actor, action: patch.status === 'sent' ? 'marked_sent' : 'edited', before: { subject: row.subject, body: row.body, status: row.status }, after: next });
  });
}
