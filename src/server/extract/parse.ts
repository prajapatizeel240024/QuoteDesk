// Turns the buyer's words into values: quantities, units, need-by dates, certs and export marks.
// Pure. Anything that doesn't parse becomes null plus a note, never a guess.
import { addDays, isIsoDate } from '@/lib/dates';
import type { Cert, Uom } from '@/lib/types';

export interface Vocab {
  uom: Record<Uom, string[]>;
  certs: { vocab: Record<Cert, { synonyms: string[] }>; unspecified: string[]; none: string[] };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** 1-12 for a full month name, a 3-letter abbreviation or "sept"; 0 for any other word. */
function monthOf(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, '');
  const i = MONTHS.findIndex((m) => m === w || m.slice(0, 3) === w || (w === 'sept' && m === 'september'));
  return i + 1;
}

export function parseUom(text: string, v: Vocab): Uom | null {
  const t = text.trim().toLowerCase().replace(/\.$/, '');
  if (!t) return null;
  for (const u of ['EA', 'FT', 'PK'] as const) if (u.toLowerCase() === t || v.uom[u].includes(t)) return u;
  return null;
}

/** "1,000" -> 1000, "1.5k" -> 1500, "a box" -> 1 PK, "25 ft" -> 25 FT, "TBD" -> null. */
export function parseQty(text: string, v: Vocab): { qty: number | null; uom: Uom | null; note: string | null } {
  const t = text.trim();
  if (!t) return { qty: null, uom: null, note: null };
  const num = /^(?:approx\.?\s*|about\s+|~\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?\b\s*(.*)$/i.exec(t);
  const word = /^(a|an|one)\b\s*(.*)$/i.exec(t);
  let qty: number | null = null;
  let rest = '';
  if (num) {
    const n = Number(num[1].replace(/,/g, '')) * (num[2] ? 1000 : 1);
    if (!Number.isInteger(n) || n <= 0) return { qty: null, uom: null, note: `"${t}" isn't a whole quantity.` };
    qty = n;
    rest = num[3];
  } else if (word) {
    qty = 1;
    rest = word[2];
  } else {
    return { qty: null, uom: null, note: `"${t}" isn't a quantity.` };
  }
  const restWord = rest.replace(/^of\b.*$/i, '').trim().split(/\s+/)[0] ?? '';
  const uom = restWord ? parseUom(restWord, v) : null;
  if (!uom && /\b(box|boxes|pack|packs|pk|bag|bags)\b/i.test(rest)) return { qty, uom: 'PK', note: null };
  return { qty, uom, note: null };
}

function validDate(y: number, m: number, d: number): string | null {
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** The next date on or after the quote date with this month and day. */
function nextMonthDay(m: number, d: number, quoteDate: string): string | null {
  const y = Number(quoteDate.slice(0, 4));
  const thisYear = validDate(y, m, d);
  if (thisYear && thisYear >= quoteDate) return thisYear;
  return validDate(y + 1, m, d);
}

/** Need-by dates as buyers write them. Returns null plus a note for ASAP, past dates and anything unclear. */
export function parseDue(text: string, quoteDate: string): { date: string | null; note: string | null } {
  const t = text.trim();
  if (!t) return { date: null, note: null };
  if (/\basap\b|as soon as possible|urgent/i.test(t)) return { date: null, note: `"${t}" isn't a date, so it needs a firm one.` };
  let date: string | null = null;
  let m: RegExpExecArray | null;
  if ((m = /\b(\d+)\s*(weeks?|wks?|days?)\s*(?:aro|after receipt of order)\b/i.exec(t))) {
    date = addDays(quoteDate, Number(m[1]) * (/^d/i.test(m[2]) ? 1 : 7));
  } else if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(t))) {
    date = validDate(+m[1], +m[2], +m[3]);
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(t))) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    date = validDate(y, +m[1], +m[2]);
  } else if ((m = /\b(\d{1,2})\/(\d{1,2})\b/.exec(t))) {
    date = nextMonthDay(+m[1], +m[2], quoteDate);
  } else if ((m = /\b(\d{1,2})[-\s]([A-Za-z]{3,9})\.?[-\s,]+(\d{4})\b/.exec(t)) && monthOf(m[2])) {
    date = validDate(+m[3], monthOf(m[2]), +m[1]);
  } else if ((m = /\b([A-Za-z]{3,9}\.?)\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?/.exec(t)) && monthOf(m[1])) {
    date = m[3] ? validDate(+m[3], monthOf(m[1]), +m[2]) : nextMonthDay(monthOf(m[1]), +m[2], quoteDate);
  } else if ((m = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/i.exec(t))) {
    const [y, mo] = quoteDate.split('-').map(Number);
    const thisMonth = validDate(y, mo, Number(m[1]));
    date = thisMonth && thisMonth >= quoteDate ? thisMonth : mo === 12 ? validDate(y + 1, 1, Number(m[1])) : validDate(y, mo + 1, Number(m[1]));
  }
  if (!date) return { date: null, note: `Couldn't read "${t}" as a date.` };
  if (date < quoteDate) return { date: null, note: `${date} is before the quote date.` };
  return { date, note: null };
}

/** Cert requests: "C of C", "RoHS, REACH", "mill certs". "Yes" alone is unclear: which certs? */
export function parseCerts(text: string, v: Vocab): { certs: Cert[]; unclear: boolean; note: string | null } {
  const t = text.trim().toLowerCase();
  if (!t || v.certs.none.includes(t)) return { certs: [], unclear: false, note: null };
  if (v.certs.unspecified.includes(t)) return { certs: [], unclear: true, note: null };
  const found = new Set<Cert>();
  const unknown: string[] = [];
  for (const piece of t.split(/[,;&+]|\band\b|\s\/\s/).map((s) => s.trim()).filter(Boolean)) {
    const hit = (Object.keys(v.certs.vocab) as Cert[]).find((c) => c.toLowerCase() === piece || v.certs.vocab[c].synonyms.includes(piece));
    if (hit) found.add(hit);
    else if (!v.certs.unspecified.includes(piece)) unknown.push(piece);
  }
  if (unknown.length) return { certs: [...found], unclear: true, note: `Unknown cert request: ${unknown.map((u) => `"${u}"`).join(', ')}.` };
  return { certs: [...found], unclear: found.size === 0, note: null };
}

export function parseExportMark(text: string): boolean {
  return /^(y|yes|x|ec|true|export controlled|controlled)$/i.test(text.trim());
}

/** Need-by dates or certs the email applies to every line ("Need everything by Oct 20", "2 weeks ARO"). */
export function findDefaults(text: string, quoteDate: string, v: Vocab): { due: { date: string; quote: string } | null; certs: { certs: Cert[]; quote: string } | null } {
  let due: { date: string; quote: string } | null = null;
  const aro = /\b\d+\s*(?:weeks?|wks?|days?)\s*(?:ARO|after receipt of order)\b/i.exec(text);
  if (aro) {
    const d = parseDue(aro[0], quoteDate);
    if (d.date) due = { date: d.date, quote: aro[0] };
  }
  if (!due) {
    const re = /\b(?:need|needed|required|due|deliver|delivery|delivered)\b[^.\n]{0,25}?\b(?:by|before|no later than)\s*:?\s*([^.\n]+)/gi;
    for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
      const d = parseDue(m[1], quoteDate);
      if (d.date) {
        const dateText = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|(?:[A-Za-z]+\s+)?the\s+\d{1,2}(?:st|nd|rd|th))/i.exec(m[1]);
        due = { date: d.date, quote: (m[0].slice(0, m[0].length - m[1].length) + (dateText ? m[1].slice(0, dateText.index + dateText[0].length) : m[1])).trim() };
        break;
      }
    }
  }
  let certs: { certs: Cert[]; quote: string } | null = null;
  const c = /\b(?:all|every)\s+(?:items?|lines?|parts?)\s+(?:need|needs|require|requires|must (?:have|include)|with)\s+([^.\n]+)/i.exec(text);
  if (c) {
    const parsed = parseCerts(c[1].replace(/\bcerts?\b|\bcertificates?\b/gi, '').trim() || c[1], v);
    if (parsed.certs.length && !parsed.unclear) certs = { certs: parsed.certs, quote: c[0].trim() };
  }
  return { due, certs };
}
