// Part matching for an RFQ: rules first, then one batched Claude call for the hard cases, then the bar
// Claude must clear. Below the bar, a line waits in "Needs a part" with Claude's suggestion attached.
import type { Candidate, ExtractedLine, LLM, MatchAnswer, MatchItem, MatchMethod, MatchStatus } from '@/lib/types';
import { norm } from '@/server/extract/text';
import { ruleMatch, specConflicts, type CatalogIndex, type RuleResult } from './rules';

export interface LineMatch {
  status: MatchStatus;
  method: MatchMethod | null;
  sku: string | null;
  confidence: number | null;
  evidence: { signal: string; value: string }[];
  suggestion: MatchAnswer | null;
  candidates: Candidate[];
  claude_said_none: boolean;
  rule: RuleResult['kind'];
}

/** MATCH_THRESHOLD as a number above 0 and at most 1. Anything else stops the run: a bad value would let every answer through. */
export function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return 0.8;
  const t = raw.trim();
  const n = Number(t);
  if (!/^(?:0?\.\d+|1(?:\.0*)?|0)$/.test(t) || !Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`MATCH_THRESHOLD must be a number above 0 and at most 1, such as 0.80. Got "${raw}".`);
  }
  return n;
}

export function requestText(l: Pick<ExtractedLine, 'requested'>): string {
  return [l.requested.part_text.trim(), l.requested.description.trim()].filter(Boolean).join(' | ');
}

function quoteIsReal(q: string, text: string): boolean {
  const nq = norm(q);
  return nq.length >= 2 && norm(text).includes(nq);
}

/** Whether Claude's answer clears the bar: a listed candidate, confident, quoting the request, no size conflict. */
export function decide(rule: RuleResult, answer: MatchAnswer | null, item: MatchItem | null, threshold: number, idx: CatalogIndex): LineMatch {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error(`decide() needs a threshold above 0 and at most 1, got ${threshold}`);
  if (rule.kind === 'exact') return { status: 'auto', method: 'rule', sku: rule.sku, confidence: null, evidence: [{ signal: rule.via, value: rule.value }], suggestion: null, candidates: [], claude_said_none: false, rule: rule.kind };
  const queued: LineMatch = { status: 'needs_review', method: null, sku: null, confidence: answer?.confidence ?? null, evidence: [], suggestion: answer, candidates: rule.candidates, claude_said_none: false, rule: rule.kind };
  if (!answer || !item) return queued;
  if (answer.sku === 'NONE') return { ...queued, claude_said_none: answer.confidence >= threshold };
  if (!item.candidates.some((c) => c.sku === answer.sku)) return queued;
  const quotesReal = answer.evidence.length > 0 && answer.evidence.every((q) => quoteIsReal(q, item.request));
  if (answer.confidence < threshold || !quotesReal) return queued;
  const conflicts = specConflicts(item.request, answer.sku, idx);
  if (conflicts.length) return { ...queued, evidence: conflicts.map((c) => ({ signal: 'size_conflict', value: c })) };
  return { status: 'auto', method: 'claude', sku: answer.sku, confidence: answer.confidence, evidence: answer.evidence.map((q) => ({ signal: 'claude_quote', value: q })), suggestion: answer, candidates: rule.candidates, claude_said_none: false, rule: rule.kind };
}

export interface MatchInput {
  line: ExtractedLine;
  held: boolean; // export holds never go to Claude
}

export async function matchLines(inputs: MatchInput[], ctx: { rfqRef: string; customerId: string | null; idx: CatalogIndex; llm: LLM; threshold: number }): Promise<{ matches: LineMatch[]; asked: number }> {
  const rules = inputs.map((i) => ruleMatch(i.line.requested, ctx.customerId, ctx.idx));
  const items = new Map<number, MatchItem>();
  inputs.forEach((inp, i) => {
    const r = rules[i];
    if (inp.held || r.kind === 'exact' || r.kind === 'none' || !r.candidates.length) return;
    items.set(i, { ref: `line-${i + 1}`, rfq_ref: ctx.rfqRef, request: requestText(inp.line), reason: r.kind, candidates: r.candidates, source: inp.line.source });
  });
  const answers = new Map<string, MatchAnswer>();
  if (items.size) for (const a of await ctx.llm.match([...items.values()])) answers.set(a.line_ref, a);
  const matches = inputs.map((inp, i) => {
    const item = items.get(i) ?? null;
    const m = decide(rules[i], item ? answers.get(item.ref) ?? null : null, item, ctx.threshold, ctx.idx);
    return inp.held && m.status !== 'auto' ? { ...m, evidence: [{ signal: 'export_hold', value: 'not sent to Claude' }] } : m;
  });
  return { matches, asked: items.size };
}
