// Display helpers shared by the server (emails, flag messages) and the review screen. Client-safe.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function money(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Basis points as a percent with one decimal: 1800 -> "18.0%". */
export function pct(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const abs = Math.abs(bps);
  return `${sign}${Math.floor(abs / 100)}.${Math.floor((abs % 100) / 10)}%`;
}

export function shortDate(d: string): string {
  const [, m, day] = d.split('-').map(Number);
  return `${MONTHS[m - 1]} ${day}`;
}

export function longDate(d: string): string {
  const [y, m, day] = d.split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
  return `${DAYS[w]}, ${MONTHS[m - 1]} ${day}, ${y}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function qtyText(n: number, uom: string): string {
  return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${uom}`;
}
