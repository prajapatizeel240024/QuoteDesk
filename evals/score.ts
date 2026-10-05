// Everything that reads answer keys: loading them, the oracle stand-in, and scoring.
// The oracle answers from the keys so the pipeline, the screen and the scorer can be tested without Claude.
// It is never a result: reports label it, the review screen footer shows it, and it refuses the holdout.
import fs from 'node:fs';
import path from 'node:path';
import type { Cert, ExtractRequest, LLM, MatchItem, PriceResult, QuestionRequest, Requested, SourceRef, Uom } from '@/lib/types';
import { norm } from '@/server/extract/text';
import { templateQuestion } from '@/server/questions/template';

export interface KeyLine {
  id: string;
  source: { doc: string; kind: 'xlsx' | 'pdf' | 'body'; index?: number; quote?: string };
  extract_by: 'rule' | 'claude';
  requested: Requested;
  expected: {
    sku: string | null;
    quoted_sku: string | null;
    review: boolean;
    qty: number | null;
    uom: Uom;
    due_date: string | null;
    certs: Cert[];
    certs_unclear: boolean;
    missing: string[];
    export_hold: string | null;
    flags: string[];
    price: { billed_qty: number; unit_cents: number; extended_cents: number; min_line_adjust_cents: number; rush_fee_cents: number; line_total_cents: number; arrive_date: string; misses_due: boolean } | null;
  };
  traps: string[];
}
export interface Key {
  rfq_id: string;
  split: 'dev' | 'holdout';
  customer_id: string;
  quote_date: string;
  defaults: { due_date: string | null; certs: Cert[]; quote: string } | null;
  lines: KeyLine[];
  traps: { kind: string; lines: string[] }[];
}

const keysDir = () => path.join(/*turbopackIgnore: true*/ process.cwd(), 'evals', 'keys');

export function loadKey(id: string): Key {
  return JSON.parse(fs.readFileSync(path.join(keysDir(), `${id}.key.json`), 'utf8')) as Key;
}

export function listRfqs(split: 'dev' | 'holdout' | 'all' = 'all'): string[] {
  return fs
    .readdirSync(keysDir())
    .filter((f) => /^rfq-\d{2}\.key\.json$/.test(f))
    .map((f) => f.replace('.key.json', ''))
    .sort()
    .filter((id) => split === 'all' || loadKey(id).split === split);
}

function jaccard(a: string, b: string): number {
  const ta = new Set(norm(a).split(/\W+/).filter(Boolean));
  const tb = new Set(norm(b).split(/\W+/).filter(Boolean));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  return inter / (new Set([...ta, ...tb]).size || 1);
}

/** The key line a system line came from: same table row, or free text whose quote mostly overlaps. */
export function keyLineFor(key: Key, src: SourceRef, taken: Set<string> = new Set()): KeyLine | null {
  if (src.index !== undefined) return key.lines.find((l) => !taken.has(l.id) && l.source.doc === src.doc && l.source.index === src.index) ?? null;
  let best: { l: KeyLine; j: number } | null = null;
  for (const l of key.lines) {
    if (taken.has(l.id) || l.source.index !== undefined || l.source.doc !== src.doc) continue;
    const j = jaccard(l.source.quote ?? '', src.quote);
    if (j > (best?.j ?? 0)) best = { l, j };
  }
  return best && best.j >= 0.5 ? best.l : null;
}

const META = { promptVersion: 'oracle', model: 'answer-key' };

export function oracleLLM(): LLM {
  return {
    name: 'oracle',
    async extract(req: ExtractRequest) {
      const key = loadKey(req.rfq_ref);
      const items = key.lines
        .filter((l) => l.extract_by === 'claude')
        .flatMap((l) => {
          const block = req.blocks.find((b) => b.doc === l.source.doc && norm(b.text).includes(norm(l.source.quote ?? '')));
          if (!block) return [];
          const r = l.requested;
          return [{ block_ref: block.ref, quote: l.source.quote!, part_text: r.part_text, description: r.description, qty_text: r.qty_text, uom_text: r.uom_text, due_text: r.due_text, certs_text: r.certs_text }];
        });
      const d = key.defaults && req.blocks.some((b) => norm(b.text).includes(norm(key.defaults!.quote))) ? key.defaults : null;
      return { items, defaults: { quote: d?.quote ?? '', due_text: d?.quote ?? '', certs_text: '' }, meta: META };
    },
    async match(items: MatchItem[]) {
      return items.map((i) => {
        const key = loadKey(i.rfq_ref);
        const kl = keyLineFor(key, i.source);
        const quote = i.request.split(' | ')[0].split(/\s+/).slice(0, 4).join(' ');
        const want = kl?.expected.sku ?? null;
        if (!want || !i.candidates.some((c) => c.sku === want)) {
          return { line_ref: i.ref, sku: 'NONE', confidence: want ? 0.4 : 0.9, evidence: [quote], why: 'The answer key has no listed candidate for this line.' };
        }
        return { line_ref: i.ref, sku: want, confidence: kl!.expected.review ? 0.55 : 0.95, evidence: [quote], why: 'From the answer key.' };
      });
    },
    async question(req: QuestionRequest) {
      return { ...templateQuestion(req), meta: META };
    },
  };
}

// ---------------------------------------------------------------- scoring

export interface SysLine {
  id: string;
  line_no: number;
  source: SourceRef;
  extraction_method: 'rule' | 'claude';
  qty: number | null;
  uom: Uom;
  due_date: string | null;
  certs: string[];
  certs_unclear: boolean;
  part_sku: string | null;
  requested_sku: string | null;
  match_status: string;
  match_method: string | null;
  export_hold: string | null;
  status: string;
  approved_by: string | null;
  price: PriceResult | null;
  flags: { code: string; severity: string }[];
}

export interface RfqScore {
  rfq: string;
  keyLines: number;
  extracted: number;
  paired: number;
  fieldOk: Record<'qty' | 'uom' | 'due' | 'certs', number>;
  claudeExtracted: number;
  autoMatched: number;
  autoCorrect: number;
  wrongParts: { line: number; got: string; want: string | null }[];
  queued: number;
  shouldAsk: number;
  askedWhenShould: number;
  heldExpected: number;
  heldCaught: number;
  heldPriced: number;
  flags: Record<string, { expected: number; found: number; extra: number }>;
  priceChecked: number;
  priceExact: number;
  priceMisses: { line: number; field: string; got: number; want: number }[];
  autoApproved: number;
  autoApprovedWrong: number;
  linesNeedingPerson: number;
}

const PRICE_FIELDS = ['billed_qty', 'unit_cents', 'extended_cents', 'min_line_adjust_cents', 'rush_fee_cents', 'line_total_cents'] as const;

export function scoreRfq(key: Key, lines: SysLine[]): RfqScore {
  const s: RfqScore = { rfq: key.rfq_id, keyLines: key.lines.length, extracted: lines.length, paired: 0, fieldOk: { qty: 0, uom: 0, due: 0, certs: 0 }, claudeExtracted: lines.filter((l) => l.extraction_method === 'claude').length, autoMatched: 0, autoCorrect: 0, wrongParts: [], queued: 0, shouldAsk: 0, askedWhenShould: 0, heldExpected: 0, heldCaught: 0, heldPriced: 0, flags: {}, priceChecked: 0, priceExact: 0, priceMisses: [], autoApproved: 0, autoApprovedWrong: 0, linesNeedingPerson: 0 };
  const taken = new Set<string>();
  for (const l of lines) {
    const k = keyLineFor(key, l.source, taken);
    if (l.status === 'approved' && l.approved_by?.startsWith('rule:')) s.autoApproved += 1;
    if (l.status === 'draft' && (l.flags.some((f) => f.severity !== 'info') || l.match_status === 'needs_review' || l.export_hold)) s.linesNeedingPerson += 1;
    if (!k) continue;
    taken.add(k.id);
    s.paired += 1;
    const e = k.expected;
    if (l.qty === e.qty) s.fieldOk.qty += 1;
    if (l.uom === e.uom) s.fieldOk.uom += 1;
    if (l.due_date === e.due_date) s.fieldOk.due += 1;
    if ([...l.certs].sort().join(',') === [...e.certs].sort().join(',') && l.certs_unclear === e.certs_unclear) s.fieldOk.certs += 1;
    if (e.export_hold) {
      s.heldExpected += 1;
      if (l.export_hold) s.heldCaught += 1;
    }
    if (l.export_hold && l.price) s.heldPriced += 1;
    const asked = l.requested_sku ?? l.part_sku;
    if (e.review) s.shouldAsk += 1;
    if (l.match_status === 'needs_review') {
      s.queued += 1;
      if (e.review) s.askedWhenShould += 1;
    } else if (l.match_status === 'auto' && asked) {
      s.autoMatched += 1;
      if (asked === e.sku) s.autoCorrect += 1;
      else s.wrongParts.push({ line: l.line_no, got: asked, want: e.sku });
    }
    if (l.status === 'approved' && l.approved_by?.startsWith('rule:') && asked !== e.sku) s.autoApprovedWrong += 1;
    const got = new Set(l.flags.map((f) => f.code));
    for (const code of new Set([...e.flags, ...got])) {
      const f = (s.flags[code] ??= { expected: 0, found: 0, extra: 0 });
      if (e.flags.includes(code)) {
        f.expected += 1;
        if (got.has(code)) f.found += 1;
      } else f.extra += 1;
    }
    if (e.price && l.price && (l.part_sku === e.quoted_sku)) {
      s.priceChecked += 1;
      const misses = PRICE_FIELDS.filter((f) => l.price![f] !== e.price![f]);
      if (!misses.length && l.price.arrive_date === e.price.arrive_date) s.priceExact += 1;
      for (const f of misses) s.priceMisses.push({ line: l.line_no, field: f, got: l.price[f], want: e.price[f] });
    }
  }
  return s;
}
