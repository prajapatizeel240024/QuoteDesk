// Pulls every line item out of an RFQ. Rules first: spreadsheet and PDF tables, bullet lines, numbered lists,
// and export screening. Claude reads only the free text the rules couldn't, after screened clauses are cut
// out, and every field it returns must be copied from the email. Code then parses all values.
import type { Config, Customer } from '@/lib/config';
import type { Cert, ExtractBlock, ExtractedLine, LLM, MissingField, Requested, SourceRef } from '@/lib/types';
import type { ParsedDoc } from '@/server/ingest/fixture';
import { findDefaults, parseCerts, parseDue, parseExportMark, parseQty, parseUom, type Vocab } from './parse';
import { pdfGrid, readTable, sheetGrid, type Field } from './table';
import { bulletItem, listItem, looksLikeItem, norm, redact, REDACTED, screenText } from './text';

interface Raw {
  source: SourceRef;
  requested: Requested;
  method: 'rule' | 'claude';
  screened: string | null;
  order: [number, number];
  notes: string[];
}

export interface ExtractResult {
  lines: ExtractedLine[];
  defaults: { due: { date: string; quote: string } | null; certs: { certs: Cert[]; quote: string } | null; by: 'rule' | 'claude' | null };
  asked_claude: boolean;
  dropped: { quote: string; reason: string }[];
  prompt_version: string | null;
}

export interface ExtractContext {
  rfqRef: string;
  from: string;
  subject: string;
  quoteDate: string;
  docs: ParsedDoc[];
  customer: Customer;
  cfg: Config;
  findPart: (s: string) => string | null;
  llm: LLM;
}

const blank = (): Requested => ({ part_text: '', description: '', qty_text: '', uom_text: '', due_text: '', certs_text: '', export_text: '' });
const fromValues = (v: Record<Field, string>): Requested => ({ part_text: v.part, description: v.description, qty_text: v.qty, uom_text: v.uom, due_text: v.due, certs_text: v.certs, export_text: v.export });
const FIELD_NAMES: Record<string, string> = { part_text: 'part number', description: 'description', qty_text: 'quantity', uom_text: 'unit', due_text: 'need-by date', certs_text: 'cert request' };
const overlaps = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));

export async function extractRfq(ctx: ExtractContext): Promise<ExtractResult> {
  const vocab: Vocab = { uom: ctx.cfg.extraction.uom, certs: ctx.cfg.certs };
  const terms = ctx.cfg.extraction.export_screen_terms;
  const screenedIn = (s: string) => terms.find((t) => norm(s).includes(norm(t))) ?? null;
  const raws: Raw[] = [];
  const free: { ref: string; doc: string; kind: 'pdf' | 'body'; text: string; order: number }[] = [];

  ctx.docs.forEach((d, di) => {
    if (d.kind === 'xlsx') {
      for (const sheet of d.sheets ?? []) {
        for (const r of readTable(sheetGrid(sheet), ctx.cfg, true)?.rows ?? []) {
          raws.push({ source: { doc: d.filename, kind: 'xlsx', sheet: r.sheet, row: r.row, index: r.index, quote: r.quote }, requested: fromValues(r.values), method: 'rule', screened: null, order: [di, r.index], notes: [] });
        }
      }
    } else if (d.kind === 'pdf') {
      const lines = d.pdf?.lines ?? [];
      const grid = pdfGrid(lines, ctx.cfg);
      const table = grid ? readTable(grid, ctx.cfg, false) : null;
      const used = new Set<string>();
      if (table) {
        used.add(`${table.header.page}:${table.header.row}`);
        for (const r of table.rows) {
          used.add(`${r.page}:${r.row}`);
          raws.push({ source: { doc: d.filename, kind: 'pdf', page: r.page, row: r.row, index: r.index, quote: r.quote }, requested: fromValues(r.values), method: 'rule', screened: null, order: [di, r.index], notes: [] });
        }
      }
      const text = lines.filter((l) => !used.has(`${l.page}:${l.line}`)).map((l) => l.text).join('\n');
      if (text.trim()) free.push({ ref: d.filename, doc: d.filename, kind: 'pdf', text, order: di });
    } else {
      free.push({ ref: d.filename, doc: d.filename, kind: 'body', text: d.text ?? '', order: di });
    }
  });

  // Free text: rules, then screening. Anything left that looks like an item goes to Claude.
  let needsClaude = false;
  const cut = new Map<string, string[]>();
  for (const b of free) {
    b.text.split('\n').forEach((line, li) => {
      const item = listItem(line, ctx.findPart) ?? bulletItem(line, (s) => Boolean(ctx.findPart(s)));
      if (item) {
        const term = screenedIn(`${item.part_text} ${item.description}`);
        raws.push({ source: { doc: b.doc, kind: b.kind, row: li + 1, quote: item.quote }, requested: { ...blank(), part_text: item.part_text, description: item.description, qty_text: item.qty_text, uom_text: item.uom_text }, method: 'rule', screened: term, order: [b.order, b.text.indexOf(item.quote)], notes: [] });
        if (term) cut.set(b.ref, [...(cut.get(b.ref) ?? []), item.quote]);
        return;
      }
      const hits = screenText(line, terms);
      for (const h of hits) {
        raws.push({ source: { doc: b.doc, kind: b.kind, row: li + 1, quote: h.quote }, requested: { ...blank(), description: h.description, qty_text: h.qty_text }, method: 'rule', screened: h.term, order: [b.order, b.text.indexOf(h.quote)], notes: [] });
        cut.set(b.ref, [...(cut.get(b.ref) ?? []), h.quote]);
      }
      if (looksLikeItem(redact(line, hits.map((h) => h.quote)))) needsClaude = true;
    });
  }

  const ruleDefaults = findDefaults(free.map((b) => b.text).join('\n'), ctx.quoteDate, vocab);
  let claudeDue: { date: string; quote: string } | null = null;
  const dropped: ExtractResult['dropped'] = [];
  let promptVersion: string | null = null;

  if (needsClaude) {
    const blocks: ExtractBlock[] = free.map((b) => ({ ref: b.ref, doc: b.doc, kind: b.kind, text: redact(b.text, cut.get(b.ref) ?? []) }));
    const ruleQuotes = raws.filter((r) => r.source.kind !== 'xlsx' && r.source.index === undefined).map((r) => r.source.quote);
    const out = await ctx.llm.extract({ rfq_ref: ctx.rfqRef, from: ctx.from, subject: ctx.subject, blocks, already_found: ruleQuotes });
    promptVersion = out.meta.promptVersion;
    for (const it of out.items) {
      const b = blocks.find((x) => x.ref === it.block_ref);
      const original = free.find((x) => x.ref === it.block_ref);
      if (!b || !original) {
        dropped.push({ quote: it.quote, reason: `Claude cited a part of the email that doesn't exist ("${it.block_ref}").` });
        continue;
      }
      if (!it.quote.trim() || !norm(b.text).includes(norm(it.quote))) {
        dropped.push({ quote: it.quote, reason: "Claude's quote isn't in the email, so the item was left out." });
        continue;
      }
      if (norm(it.quote).includes(norm(REDACTED))) {
        dropped.push({ quote: it.quote, reason: 'Part of an item held for export review.' });
        continue;
      }
      if (ruleQuotes.some((q) => overlaps(q, it.quote))) {
        dropped.push({ quote: it.quote, reason: 'The rules already found this item.' });
        continue;
      }
      const req = blank();
      const notes: string[] = [];
      for (const f of ['part_text', 'description', 'qty_text', 'uom_text', 'due_text', 'certs_text'] as const) {
        const v = (it[f] ?? '').trim();
        if (!v) continue;
        if (norm(it.quote).includes(norm(v))) req[f] = v;
        else notes.push(`Claude's ${FIELD_NAMES[f]} "${v}" isn't in the quoted text, so it was left out.`);
      }
      raws.push({ source: { doc: b.doc, kind: b.kind, quote: it.quote.trim() }, requested: req, method: 'claude', screened: screenedIn(`${req.part_text} ${req.description} ${it.quote}`), order: [original.order, original.text.indexOf(it.quote.trim())], notes });
    }
    const dq = out.defaults.quote.trim();
    if (!ruleDefaults.due && out.defaults.due_text.trim() && dq && blocks.some((b) => norm(b.text).includes(norm(dq)))) {
      const d = parseDue(out.defaults.due_text, ctx.quoteDate);
      if (d.date) claudeDue = { date: d.date, quote: dq };
    }
  }

  const due = ruleDefaults.due ?? claudeDue;
  const defaultCerts = ruleDefaults.certs?.certs ?? [];
  const customerCerts = ctx.customer.rules.default_certs as Cert[];
  raws.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);

  const lines: ExtractedLine[] = raws.map((r) => {
    const notes = [...r.notes];
    const q = parseQty(r.requested.qty_text, vocab);
    if (q.note) notes.push(q.note);
    const u = parseUom(r.requested.uom_text, vocab);
    if (r.requested.uom_text && !u) notes.push(`Unit "${r.requested.uom_text}" isn't one QuoteDesk knows, so the line is quoted per piece.`);
    let dueDate: string | null = null;
    if (r.requested.due_text) {
      const d = parseDue(r.requested.due_text, ctx.quoteDate);
      dueDate = d.date;
      if (d.note) notes.push(d.note);
    }
    if (!dueDate && due && !/asap|urgent|as soon/i.test(r.requested.due_text)) {
      dueDate = due.date;
      notes.push(`Need-by date from the email: "${due.quote}".`);
    }
    const c = parseCerts(r.requested.certs_text, vocab);
    if (c.note) notes.push(c.note);
    const added = [...defaultCerts, ...customerCerts].filter((x) => !c.certs.includes(x));
    if (added.length) notes.push(`${[...new Set(added)].join(' and ')} added: ${customerCerts.some((x) => added.includes(x)) ? `${ctx.customer.short_name} always gets ${customerCerts.join(', ')}` : `the email asks for it on every line`}.`);
    const certs = [...new Set([...c.certs, ...defaultCerts, ...customerCerts])].sort() as Cert[];
    const missing: MissingField[] = [...(q.qty === null ? (['qty'] as const) : []), ...(dueDate === null ? (['due_date'] as const) : []), ...(c.unclear ? (['cert_type'] as const) : [])];
    return {
      source: r.source,
      requested: r.requested,
      method: r.method,
      qty: q.qty,
      uom: u ?? q.uom ?? 'EA',
      due_date: dueDate,
      certs,
      certs_unclear: c.unclear,
      export_marked: parseExportMark(r.requested.export_text),
      screened_term: r.screened ?? screenedIn(`${r.requested.part_text} ${r.requested.description}`),
      missing,
      notes,
    };
  });
  return { lines, defaults: { due, certs: ruleDefaults.certs, by: ruleDefaults.due ? 'rule' : claudeDue ? 'claude' : null }, asked_claude: needsClaude, dropped, prompt_version: promptVersion };
}
