// Loads a synthetic RFQ (evals/rfqs/<id>/message.json plus its attachments), parses every attachment, and
// stores the email and the parsed documents. Parsing happens once, at ingest; later steps read the stored rows.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { identifyCustomer, loadConfig } from '@/lib/config';
import { withTx } from '@/server/db';
import { audit } from '@/server/lines/audit';
import { readPdf, type PdfLine } from './pdf';
import { readXlsx, type Sheet } from './xlsx';

export const MessageZ = z.strictObject({
  id: z.string().regex(/^rfq-\d{2}$/),
  received_at: z.string(),
  from: z.strictObject({ name: z.string(), email: z.string() }),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  attachments: z.array(z.strictObject({ filename: z.string().regex(/^[\w.\- ]+$/), content_type: z.string() })),
});
export type Message = z.infer<typeof MessageZ>;

export interface ParsedDoc {
  filename: string;
  kind: 'xlsx' | 'pdf' | 'body';
  sha256: string;
  sheets?: Sheet[];
  pdf?: { pages: number; lines: PdfLine[] };
  text?: string;
}

export const BODY_DOC = 'email body';

export function fixtureDir(id: string): string {
  if (!/^rfq-\d{2}$/.test(id)) throw new Error(`"${id}" isn't an RFQ fixture id`);
  return path.join(/*turbopackIgnore: true*/ process.cwd(), 'evals', 'rfqs', id);
}

export function listFixtures(): string[] {
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), 'evals', 'rfqs');
  return fs.readdirSync(dir).filter((d) => /^rfq-\d{2}$/.test(d)).sort();
}

export function loadMessage(id: string): Message {
  return MessageZ.parse(JSON.parse(fs.readFileSync(path.join(fixtureDir(id), 'message.json'), 'utf8')));
}

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

export async function parseAttachment(filename: string, buf: Buffer): Promise<ParsedDoc> {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.xlsx') return { filename, kind: 'xlsx', sha256: sha(buf), sheets: await readXlsx(buf) };
  if (ext === '.pdf') return { filename, kind: 'pdf', sha256: sha(buf), pdf: await readPdf(buf) };
  throw new Error(`QuoteDesk reads .xlsx and .pdf attachments, not ${ext || 'files without an extension'} (${filename})`);
}

/** Attachments in the order the email lists them, then the email body. */
export async function parseFixture(id: string): Promise<{ message: Message; docs: ParsedDoc[] }> {
  const message = loadMessage(id);
  const docs: ParsedDoc[] = [];
  for (const a of message.attachments) docs.push(await parseAttachment(a.filename, fs.readFileSync(path.join(fixtureDir(id), a.filename))));
  docs.push({ filename: BODY_DOC, kind: 'body', sha256: sha(message.body), text: message.body });
  return { message, docs };
}

/** The quote date is the day the RFQ arrived, in the distributor's time zone. */
export function quoteDateFor(receivedAt: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(receivedAt));
}

export async function ingestFixture(pool: Pool, id: string, actor = 'system'): Promise<{ rfqId: string; created: boolean }> {
  const existing = await pool.query<{ id: string }>('select id from rfqs where fixture_id = $1', [id]);
  if (existing.rowCount) return { rfqId: existing.rows[0].id, created: false };
  const cfg = loadConfig();
  const { message, docs } = await parseFixture(id);
  const who = identifyCustomer(message.from.email, message.body, cfg);
  const quoteDate = quoteDateFor(message.received_at, cfg.distributor.timezone);
  return withTx(pool, async (c) => {
    const ins = await c.query<{ id: string }>(
      `insert into rfqs (fixture_id, customer_id, customer_basis, from_name, from_email, subject, body, received_at, quote_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (fixture_id) do nothing returning id`,
      [id, who?.customer.id ?? null, JSON.stringify(who?.basis ?? {}), message.from.name, message.from.email, message.subject, message.body, message.received_at, quoteDate],
    );
    if (!ins.rowCount) {
      const again = await c.query<{ id: string }>('select id from rfqs where fixture_id = $1', [id]);
      return { rfqId: again.rows[0].id, created: false };
    }
    const rfqId = ins.rows[0].id;
    for (const d of docs) {
      const parsed = d.kind === 'xlsx' ? { sheets: d.sheets } : d.kind === 'pdf' ? { pdf: d.pdf } : { text: d.text };
      await c.query('insert into rfq_documents (rfq_id, filename, kind, sha256, parsed) values ($1,$2,$3,$4,$5)', [rfqId, d.filename, d.kind, d.sha256, JSON.stringify(parsed)]);
    }
    await audit(c, { subject_type: 'rfq', subject_id: rfqId, actor, action: 'received', after: { fixture_id: id, from: message.from.email, attachments: message.attachments.map((a) => a.filename), customer: who?.customer.id ?? null, customer_basis: who?.basis ?? null } });
    return { rfqId, created: true };
  });
}

export async function loadDocs(pool: Pool, rfqId: string): Promise<ParsedDoc[]> {
  const res = await pool.query<{ filename: string; kind: ParsedDoc['kind']; sha256: string; parsed: Omit<ParsedDoc, 'filename' | 'kind' | 'sha256'> }>(
    `select filename, kind, sha256, parsed from rfq_documents where rfq_id = $1 order by (kind = 'body'), filename`,
    [rfqId],
  );
  return res.rows.map((r) => ({ filename: r.filename, kind: r.kind, sha256: r.sha256, ...r.parsed }));
}
