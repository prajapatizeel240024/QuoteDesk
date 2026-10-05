import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { findDefaults, parseCerts, parseDue, parseExportMark, parseQty, type Vocab } from '@/server/extract/parse';
import { bulletItem, listItem, redact, screenText } from '@/server/extract/text';

const cfg = loadConfig();
const v: Vocab = { uom: cfg.extraction.uom, certs: cfg.certs };

describe('quantities and units', () => {
  it.each([
    ['500', 500, null], ['1,000', 1000, null], ['1.5k', 1500, null], ['5k', 5000, null], ['a box', 1, 'PK'], ['1 pack', 1, 'PK'], ['25 ft', 25, 'FT'], ['200 pcs', 200, 'EA'],
  ])('%s -> %s %s', (text, qty, uom) => expect(parseQty(text, v)).toMatchObject({ qty, uom }));
  it('never guesses a quantity', () => {
    expect(parseQty('TBD', v).qty).toBeNull();
    expect(parseQty('2.5', v)).toMatchObject({ qty: null });
    expect(parseQty('', v)).toEqual({ qty: null, uom: null, note: null });
  });
});

describe('need-by dates', () => {
  it.each([
    ['10/20/2026', '2026-10-05', '2026-10-20'], ['10/09/26', '2026-10-07', '2026-10-09'], ['10/28', '2026-10-14', '2026-10-28'], ['2026-10-23', '2026-10-07', '2026-10-23'],
    ['Oct 20', '2026-10-06', '2026-10-20'], ['October 30, 2026', '2026-10-08', '2026-10-30'], ['Friday the 16th if possible', '2026-10-06', '2026-10-16'], ['2 weeks ARO', '2026-10-12', '2026-10-26'], ['20-Oct-2026', '2026-10-06', '2026-10-20'],
  ])('%s (quoted %s) -> %s', (text, quote, want) => expect(parseDue(text, quote).date).toBe(want));
  it('asks instead of guessing', () => {
    expect(parseDue('ASAP', '2026-10-13')).toMatchObject({ date: null });
    expect(parseDue('ASAP', '2026-10-13').note).toMatch(/isn't a date/);
    expect(parseDue('2026-10-01', '2026-10-05').date).toBeNull();
    expect(parseDue('Marine 3', '2026-10-05').date).toBeNull();
    expect(parseDue('the end of the week', '2026-10-05').date).toBeNull();
  });
});

describe('certs and export marks', () => {
  it('reads cert requests through synonyms', () => {
    expect(parseCerts('C of C', v)).toMatchObject({ certs: ['CoC'], unclear: false });
    expect(parseCerts('RoHS, REACH', v).certs).toEqual(['RoHS', 'REACH']);
    expect(parseCerts('mill certs', v).certs).toEqual(['MTR']);
    expect(parseCerts('N/A', v)).toMatchObject({ certs: [], unclear: false });
  });
  it('flags a request that does not say which certs', () => {
    expect(parseCerts('Yes', v)).toMatchObject({ certs: [], unclear: true });
    expect(parseCerts('PPAP', v)).toMatchObject({ unclear: true });
  });
  it('reads export marks', () => {
    expect(['Y', 'yes', 'EC'].map(parseExportMark)).toEqual([true, true, true]);
    expect(['N', '', 'no'].map(parseExportMark)).toEqual([false, false, false]);
  });
});

describe('free text', () => {
  it('finds dates the email applies to every line', () => {
    expect(findDefaults('Need everything by Oct 20 please.', '2026-10-06', v).due).toEqual({ date: '2026-10-20', quote: 'Need everything by Oct 20' });
    expect(findDefaults('Need these 2 weeks ARO.', '2026-10-12', v).due?.date).toBe('2026-10-26');
    expect(findDefaults('We need pricing by the end of the week.', '2026-10-08', v).due).toBeNull();
  });
  it('reads bullet lines and numbered lists only when the part number is known', () => {
    const known = (s: string) => s === 'KF-JM-0606';
    expect(bulletItem('- 4 x KF-JM-0606', known)).toMatchObject({ qty_text: '4', part_text: 'KF-JM-0606' });
    expect(bulletItem('- 4 x XX-0000', known)).toBeNull();
    expect(bulletItem('40 of the 1/2-13 x 2 grade 5 hex bolts', () => true)).toBeNull();
    expect(listItem('3. Prox sensor M12, VE-PX12-4P-C - qty 10', (s) => (s === 'VE-PX12-4P-C' ? 'AF-40102' : null))).toMatchObject({ part_text: 'VE-PX12-4P-C', qty_text: '10' });
  });
  it('screens export terms before anything goes to Claude, and cuts them out', () => {
    const body = 'We need a quote on 3 of the 8-axis motion controllers, 20 of the M12 prox sensors, and a pack of screws.';
    const hits = screenText(body, cfg.extraction.export_screen_terms);
    expect(hits).toEqual([{ term: 'motion controller', quote: '3 of the 8-axis motion controllers', qty_text: '3', description: '8-axis motion controllers' }]);
    expect(redact(body, hits.map((h) => h.quote))).not.toMatch(/motion/);
  });
});
