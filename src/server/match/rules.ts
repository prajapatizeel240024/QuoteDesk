// Rule matching against the catalog: exact part numbers after cleanup (SKU, manufacturer number, aliases,
// customer part numbers), then one-character typos, then description retrieval. Rules decide only exact
// matches; everything else becomes candidates for Claude, and below Claude's bar, for a person.
import type { Candidate, Part } from '@/lib/types';
import { compact, isSpecToken, tokens, withinOneEdit } from './normalize';

export interface MatchVocab {
  synonyms: Record<string, string>;
  stop: string[];
}

export interface CatalogIndex {
  parts: Map<string, Part>;
  keys: Map<string, Map<string, 'sku' | 'mfr_part' | 'alias'>>; // compact key -> SKU -> how it's known
  xref: Map<string, Map<string, string>>; // customer -> compact customer part number -> SKU
  docs: Map<string, Set<string>>; // SKU -> description tokens
  idf: Map<string, number>;
  maxIdf: number;
  vocab: MatchVocab;
}

export function buildIndex(parts: Part[], xref: { customer_id: string; customer_pn: string; sku: string }[], vocab: MatchVocab): CatalogIndex {
  const keys: CatalogIndex['keys'] = new Map();
  const put = (k: string, sku: string, kind: 'sku' | 'mfr_part' | 'alias') => {
    if (!k) return;
    const m = keys.get(k) ?? new Map();
    if (!m.has(sku) || kind === 'sku') m.set(sku, kind);
    keys.set(k, m);
  };
  const docs = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const p of parts) {
    put(compact(p.sku), p.sku, 'sku');
    put(compact(p.mfr_part), p.sku, 'mfr_part');
    put(compact(p.supplier_part), p.sku, 'mfr_part');
    for (const a of p.aliases) put(compact(a), p.sku, 'alias');
    const toks = new Set(tokens(`${p.description} ${p.mfr_part}`, vocab.synonyms, vocab.stop));
    docs.set(p.sku, toks);
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = parts.length;
  const idf = new Map([...df].map(([t, d]) => [t, Math.log(1 + n / d)]));
  const xr: CatalogIndex['xref'] = new Map();
  for (const x of xref) {
    const m = xr.get(x.customer_id) ?? new Map();
    m.set(compact(x.customer_pn), x.sku);
    xr.set(x.customer_id, m);
  }
  return { parts: new Map(parts.map((p) => [p.sku, p])), keys, xref: xr, docs, idf, maxIdf: Math.log(1 + n), vocab };
}

export type RuleResult =
  | { kind: 'exact'; sku: string; via: 'sku' | 'mfr_part' | 'alias' | 'customer_pn'; value: string }
  | { kind: 'ambiguous'; value: string; candidates: Candidate[] }
  | { kind: 'typo'; value: string; candidates: Candidate[] }
  | { kind: 'description'; candidates: Candidate[] }
  | { kind: 'none'; candidates: Candidate[] };

/** An exact hit after cleanup, or null. Customer part numbers first, since they're specific to that buyer. */
export function exactLookup(text: string, customerId: string | null, idx: CatalogIndex): { skus: string[]; via: 'sku' | 'mfr_part' | 'alias' | 'customer_pn' } | null {
  const c = compact(text);
  if (c.length < 2) return null;
  const x = customerId ? idx.xref.get(customerId)?.get(c) : undefined;
  if (x) return { skus: [x], via: 'customer_pn' };
  const hit = idx.keys.get(c);
  if (!hit) return null;
  const skus = [...hit.keys()];
  return { skus, via: skus.length === 1 ? hit.get(skus[0])! : 'alias' };
}

export function candidate(idx: CatalogIndex, sku: string, score: number): Candidate {
  const p = idx.parts.get(sku)!;
  return { sku, description: p.description, mfr_part: p.mfr_part, score: Math.round(score * 1000) / 1000 };
}

/** Active parts ranked by how much of the request's wording (weighted, sizes double) their description covers. */
export function retrieve(text: string, idx: CatalogIndex, k = 5, min = 0.4): Candidate[] {
  const q = tokens(text, idx.vocab.synonyms, idx.vocab.stop);
  if (!q.length) return [];
  const w = (t: string) => (idx.idf.get(t) ?? idx.maxIdf) * (isSpecToken(t) ? 2 : 1);
  const total = q.reduce((s, t) => s + w(t), 0);
  const scored: Candidate[] = [];
  for (const [sku, doc] of idx.docs) {
    if (idx.parts.get(sku)!.status !== 'active') continue;
    const s = q.reduce((acc, t) => acc + (doc.has(t) ? w(t) : 0), 0) / total;
    if (s >= min) scored.push(candidate(idx, sku, s));
  }
  return scored.sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku)).slice(0, k);
}

export function ruleMatch(req: { part_text: string; description: string }, customerId: string | null, idx: CatalogIndex): RuleResult {
  const part = req.part_text.trim();
  if (part) {
    const hit = exactLookup(part, customerId, idx);
    if (hit && hit.skus.length === 1) return { kind: 'exact', sku: hit.skus[0], via: hit.via, value: part };
    if (hit) return { kind: 'ambiguous', value: part, candidates: hit.skus.map((s) => candidate(idx, s, 1)) };
    const c = compact(part);
    if (c.length >= 6) {
      const near = new Set<string>();
      for (const [k, skus] of idx.keys) if (withinOneEdit(c, k)) for (const s of skus.keys()) near.add(s);
      for (const [k, s] of customerId ? (idx.xref.get(customerId) ?? new Map<string, string>()) : new Map<string, string>()) if (withinOneEdit(c, k)) near.add(s);
      if (near.size) return { kind: 'typo', value: part, candidates: [...near].sort().map((s) => candidate(idx, s, 1)) };
    }
  }
  const candidates = retrieve(req.description || part, idx);
  return candidates.length ? { kind: 'description', candidates } : { kind: 'none', candidates: [] };
}

/** Size tokens in the request (1/2-13, M12, 6204, grade 5...) that the chosen part's description doesn't have. */
export function specConflicts(requestText: string, sku: string, idx: CatalogIndex): string[] {
  const doc = idx.docs.get(sku);
  if (!doc) return ['unknown part'];
  const asked = tokens(requestText, idx.vocab.synonyms, idx.vocab.stop).filter((t) => isSpecToken(t) || /^grade[58]$/.test(t));
  return asked.filter((t) => !doc.has(t));
}
