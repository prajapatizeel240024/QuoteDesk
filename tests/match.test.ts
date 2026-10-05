import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import type { MatchAnswer, MatchItem } from '@/lib/types';
import { loadErpExport } from '@/server/erp/catalog';
import { decide, parseThreshold } from '@/server/match/index';
import { compact, tokens, withinOneEdit } from '@/server/match/normalize';
import { buildIndex, retrieve, ruleMatch, specConflicts, type RuleResult } from '@/server/match/rules';

const cfg = loadConfig();
const erp = loadErpExport();
const idx = buildIndex(erp.parts, erp.xref, { synonyms: cfg.matching.synonyms, stop: cfg.matching.stop_words });
const req = (part_text: string, description = '') => ({ part_text, description });

describe('part number cleanup', () => {
  it('ignores case, spaces, dashes and labels', () => {
    expect(compact('tf hc5020\u2013g5z')).toBe('TFHC5020G5Z');
    expect(compact('P/N: KF-JM-0808')).toBe('KFJM0808');
  });
  it('allows one edit', () => {
    expect(withinOneEdit('TFHC5O20G5Z', 'TFHC5020G5Z')).toBe(true);
    expect(withinOneEdit('AB12', 'BA12')).toBe(true);
    expect(withinOneEdit('TFHC5O2OG5Z', 'TFHC5020G5Z')).toBe(false);
  });
  it('keeps sizes whole and folds trade words', () => {
    expect(tokens('1/2-13 x 2 grade 5 hex bolts', cfg.matching.synonyms, cfg.matching.stop_words)).toEqual(['1/2-13', '1/2', '2', 'grade5', 'hex', 'screw']);
  });
});

describe('rule matching against the ERP export', () => {
  it('matches customer part numbers only for that customer', () => {
    expect(ruleMatch(req('HPV-100233'), 'C-1001', idx)).toMatchObject({ kind: 'exact', sku: 'AF-10117', via: 'customer_pn' });
    expect(ruleMatch(req('HPV-100233'), 'C-1005', idx).kind).not.toBe('exact');
  });
  it('matches manufacturer numbers written any way', () => {
    for (const s of ['tf-hc3810-g5z', 'TF HN38 G5Z', 'OM\u2013VB\u2013A48', 'AF-30304']) expect(ruleMatch(req(s), null, idx).kind).toBe('exact');
  });
  it('sends ambiguous numbers, typos and descriptions on, with candidates', () => {
    expect(ruleMatch(req('6204'), null, idx)).toMatchObject({ kind: 'ambiguous', candidates: [{ sku: 'AF-20103' }, { sku: 'AF-20104' }] });
    expect(ruleMatch(req('TF-HC5O20-G5Z'), null, idx)).toMatchObject({ kind: 'typo', candidates: [{ sku: 'AF-10117' }] });
    const d = ruleMatch(req('', '1/2 in brass ball valve, NPT, full port'), null, idx);
    expect(d.kind === 'description' && d.candidates[0].sku).toBe('AF-30401');
    expect(ruleMatch(req('CR-BRKT-117', 'WELDMENT BRACKET PER DWG 117'), null, idx).kind).toBe('none');
  });
  it('never offers an obsolete part for a description', () => {
    expect(retrieve('M12 prox sensors, the 4mm PNP ones with the cable', idx).map((c) => c.sku)).not.toContain('AF-40190');
  });
  it('finds size conflicts', () => {
    expect(specConflicts('1/2-13 x 2 hex cap screw', 'AF-10111', idx)).toEqual(['1/2-13', '1/2']);
    expect(specConflicts('1/2-13 x 2 hex cap screw', 'AF-10117', idx)).toEqual([]);
  });
});

describe("the bar Claude's match must clear", () => {
  const rule = ruleMatch(req('', '1/2-13 x 2 grade 5 hex bolts'), null, idx) as Extract<RuleResult, { kind: 'description' }>;
  const item: MatchItem = { ref: 'line-1', rfq_ref: 'rfq-x', request: '1/2-13 x 2 grade 5 hex bolts', reason: 'description', candidates: rule.candidates, source: { doc: 'email body', kind: 'body', quote: '40 of the 1/2-13 x 2 grade 5 hex bolts' } };
  const answer = (o: Partial<MatchAnswer>): MatchAnswer => ({ line_ref: 'line-1', sku: 'AF-10117', confidence: 0.93, evidence: ['grade 5 hex bolts'], why: 'Size and grade agree.', ...o });
  it('accepts a confident pick that quotes the request', () => expect(decide(rule, answer({}), item, 0.8, idx)).toMatchObject({ status: 'auto', method: 'claude', sku: 'AF-10117' }));
  it('queues low confidence, invented quotes, missing quotes and NONE', () => {
    expect(decide(rule, answer({ confidence: 0.6 }), item, 0.8, idx).status).toBe('needs_review');
    expect(decide(rule, answer({ evidence: ['3/8 nuts'] }), item, 0.8, idx).status).toBe('needs_review');
    expect(decide(rule, answer({ evidence: [] }), item, 0.8, idx).status).toBe('needs_review');
    expect(decide(rule, answer({ sku: 'NONE', confidence: 0.9 }), item, 0.8, idx)).toMatchObject({ status: 'needs_review', claude_said_none: true });
    expect(decide(rule, null, item, 0.8, idx).status).toBe('needs_review');
  });
  it('queues a part that was not offered, or that has the wrong size', () => {
    expect(decide(rule, answer({ sku: 'AF-30401' }), item, 0.8, idx).status).toBe('needs_review');
    const withWrong = { ...item, candidates: [...item.candidates, { sku: 'AF-10111', description: 'x', mfr_part: 'x', score: 0.5 }] };
    expect(decide({ kind: 'description', candidates: withWrong.candidates }, answer({ sku: 'AF-10111' }), withWrong, 0.8, idx)).toMatchObject({ status: 'needs_review', evidence: [{ signal: 'size_conflict', value: '1/2-13' }, { signal: 'size_conflict', value: '1/2' }] });
  });
  it('keeps the suggestion when it queues', () => expect(decide(rule, answer({ confidence: 0.55 }), item, 0.8, idx).suggestion?.sku).toBe('AF-10117'));
  it('refuses a bad threshold', () => {
    expect(() => decide(rule, answer({}), item, Number.NaN, idx)).toThrow();
    expect(() => decide(rule, answer({}), item, 0, idx)).toThrow();
    expect([parseThreshold(undefined), parseThreshold('0.8'), parseThreshold('1'), parseThreshold('.75')]).toEqual([0.8, 0.8, 1, 0.75]);
    for (const bad of ['', 'abc', '0', '1.5', '-0.2']) expect(() => parseThreshold(bad)).toThrow(/MATCH_THRESHOLD/);
  });
});
