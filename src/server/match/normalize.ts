// Part-number and description normalization for matching. Pure.

/** Upper case, plain dashes, labels like "P/N:" dropped, then letters and digits only: "tf hc5020–g5z" -> "TFHC5020G5Z". */
export function compact(s: string): string {
  return s
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/^\s*(?:P\/?N|PART(?:\s*(?:NO|NUMBER|#))?|MFR|MPN|SKU|ITEM)\s*[:#.]?\s*/, '')
    .replace(/[^A-Z0-9]/g, '');
}

/** Damerau-Levenshtein distance of at most one (one substitution, insertion, deletion or adjacent swap). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length && diff.length <= 2; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

/** Description tokens: sizes like 1/2-13 kept whole (plus 1/2), inch marks as "in", grade 5 as grade5, synonyms folded. */
export function tokens(text: string, synonyms: Record<string, string>, stop: readonly string[]): string[] {
  const t = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/(\d)\s*(?:"|''|\u201d)/g, '$1 in ')
    .replace(/\b(?:grade|gr\.?|g)\s*([58])\b/g, ' grade$1 ')
    .replace(/\b(\d+)(mm|in|ft|m)\b/g, '$1 $2');
  const out = new Set<string>();
  for (const raw of t.match(/[a-z0-9#]+(?:[/\-.][a-z0-9]+)*/g) ?? []) {
    const w = synonyms[raw] ?? raw;
    if (stop.includes(w)) continue;
    out.add(w);
    const thread = /^(\d+\/\d+)-\d+$/.exec(w);
    if (thread) out.add(thread[1]);
    if (/^-?\d{3}$/.test(w)) out.add(w.replace(/^-/, ''));
  }
  return [...out];
}

/** Tokens that pin down a size: fractions, metric sizes, bearing series, chain and o-ring numbers. */
export function isSpecToken(t: string): boolean {
  return /\d/.test(t) && (/\//.test(t) || /^m\d+$/.test(t) || /^\d{4}(-2rs|-zz)?$/.test(t) || /^#\d+$/.test(t) || /^\d{3}$/.test(t) || /^[ab]\d{2}$/.test(t));
}
