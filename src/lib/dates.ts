// Calendar math on 'YYYY-MM-DD' strings in UTC, so a time zone never shifts a date. Client-safe.

const DAY_MS = 86_400_000;

export function toUtc(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

export function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(toUtc(s)) === s;
}

export function addDays(d: string, n: number): string {
  return fromUtc(toUtc(d) + n * DAY_MS);
}

export function isBusinessDay(d: string, holidays: readonly string[]): boolean {
  const w = new Date(toUtc(d)).getUTCDay();
  return w !== 0 && w !== 6 && !holidays.includes(d);
}

/** n business days after d. With n = 0 it returns d if d is a business day, else the next business day. */
export function addBusinessDays(d: string, n: number, holidays: readonly string[]): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Business days must be a whole number of 0 or more, not ${n}`);
  let cur = d;
  while (!isBusinessDay(cur, holidays)) cur = addDays(cur, 1);
  for (let left = n; left > 0; ) {
    cur = addDays(cur, 1);
    if (isBusinessDay(cur, holidays)) left -= 1;
  }
  return cur;
}

/** Business days from a (exclusive) to b (inclusive); negative when b is before a. */
export function businessDaysBetween(a: string, b: string, holidays: readonly string[]): number {
  if (b < a) return -businessDaysBetween(b, a, holidays);
  let n = 0;
  for (let cur = addDays(a, 1); cur <= b; cur = addDays(cur, 1)) if (isBusinessDay(cur, holidays)) n += 1;
  return n;
}

/** Subtracts n business days (used to back-schedule a supplier's ship date). */
export function subtractBusinessDays(d: string, n: number, holidays: readonly string[]): string {
  let cur = d;
  for (let left = n; left > 0; ) {
    cur = addDays(cur, -1);
    if (isBusinessDay(cur, holidays)) left -= 1;
  }
  return cur;
}
