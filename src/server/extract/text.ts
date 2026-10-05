// Rules for free text (email bodies, PDFs without a table): bullet lines like "- 4 x KF-JM-0606", numbered
// lists like "3. Prox sensor ... - qty 10", and export screening. Whatever looks like an item but doesn't fit
// a rule is left for Claude.

export interface TextItem {
  quote: string;
  part_text: string;
  description: string;
  qty_text: string;
  uom_text: string;
}

const PART_TOKEN = /[A-Za-z0-9][A-Za-z0-9\-\u2013\u2014/.]*\d[A-Za-z0-9\-\u2013\u2014/.]*/g;

/** "- 25 ft KF-H2W-06", "4 x KF-JM-0606", "* 2 pcs AF-30601 spare". The part number must be one we know. */
export function bulletItem(line: string, isKnownPart: (s: string) => boolean): TextItem | null {
  const m = /^\s*(?:[-*\u2022]\s*)?(\d[\d,]*(?:\.\d+)?k?)\s*(x|pcs?|ea|each|ft|feet|pk|packs?|box(?:es)?)?\s+(?:of\s+)?(?:p\/?n:?\s*)?([A-Za-z0-9][A-Za-z0-9\-\u2013\u2014/.]*\d[A-Za-z0-9\-\u2013\u2014/.]*)\s*(.*)$/i.exec(line);
  if (!m || !/^\s*(?:[-*\u2022]|\d)/.test(line) || !isKnownPart(m[3])) return null;
  const unit = m[2] && m[2].toLowerCase() !== 'x' ? m[2] : '';
  return { quote: line.trim(), part_text: m[3], description: m[4].trim(), qty_text: m[1], uom_text: unit };
}

/** "3. Prox sensor M12, connector version, VE-PX12-4P-C - qty 10". A known part number inside is picked up. */
export function listItem(line: string, findPart: (s: string) => string | null): TextItem | null {
  const m = /^\s*\d+[.)]\s+(.+?)\s+[-\u2013\u2014]\s+qty\s*:?\s*(.+)$/i.exec(line);
  if (!m) return null;
  const part = (m[1].match(PART_TOKEN) ?? []).find((t) => findPart(t)) ?? '';
  return { quote: line.trim(), part_text: part, description: m[1].trim(), qty_text: m[2].trim(), uom_text: '' };
}

const ITEM_WORDS = /\b(screws?|bolts?|nuts?|washers?|bearings?|belts?|chains?|hoses?|adapters?|fittings?|o-?rings?|valves?|cylinders?|sensors?|prox|blocks?|glands?|relays?|sockets?|motors?|controllers?|encoders?)\b/i;

/** A line that probably asks for something: a number and an item word. */
export function looksLikeItem(line: string): boolean {
  return /\d/.test(line) && ITEM_WORDS.test(line);
}

export interface ScreenHit {
  term: string;
  quote: string;
  qty_text: string;
  description: string;
}

/** Clauses that mention an export screening term. They become held lines and are cut from anything sent to Claude. */
export function screenText(text: string, terms: string[]): ScreenHit[] {
  const hits: ScreenHit[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const raw of sentence.split(/,\s*|;\s*|\s+and\s+/)) {
      const term = terms.find((t) => raw.toLowerCase().includes(t.toLowerCase()));
      if (!term) continue;
      const clause = raw
        .replace(/^.*?\b(?:quote|price|pricing)\s+(?:on|for)\s+/i, '')
        .replace(/^\s*(?:we\s+)?(?:also\s+)?need\s+/i, '')
        .replace(/^\s*\d+[.)]\s+/, '')
        .replace(/[.!?]+$/, '')
        .trim();
      const q = /^(\d[\d,]*|a|an|one)\b\s*(?:of\s+(?:the\s+)?)?(.*)$/i.exec(clause);
      const qtyInList = /\bqty\s*:?\s*(\d[\d,]*)/i.exec(clause);
      hits.push({
        term,
        quote: clause,
        qty_text: qtyInList ? qtyInList[1] : q ? q[1] : '',
        description: (qtyInList ? clause.replace(/\s+[-\u2013\u2014]\s+qty.*$/i, '') : q ? q[2] : clause).trim(),
      });
    }
  }
  return hits;
}

export const REDACTED = '[item held for export review]';

export function redact(text: string, quotes: string[]): string {
  let out = text;
  for (const q of quotes) out = out.split(q).join(REDACTED);
  return out;
}

/** Lower-case, straight quotes, single spaces: the form used to check that a quote is really in the text. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
}
