// Per-customer automation rules from config/quotedesk.yaml. A small, fixed vocabulary that a sales
// manager can edit without code; zod rejects unknown keys when the config loads.
import type { AutoWhen, CustomerRules, Flag, MatchMethod, Part, PriceResult } from '@/lib/types';

export interface AutoFacts {
  status: string;
  export_hold: string | null;
  match_method: MatchMethod | null;
  part: Part | null;
  price: PriceResult | null;
  flags: Flag[];
}

/** Each condition that fails, in words, so the screen can explain why a rule didn't fire. */
export function failedConditions(when: AutoWhen, f: AutoFacts): string[] {
  const out: string[] = [];
  if (f.status !== 'draft') out.push('the line is not a draft');
  if (f.export_hold) out.push('export-controlled lines always need a person');
  if (!f.part || !f.price) out.push('the line has no part or no price');
  if (when.match_method && (!f.match_method || !when.match_method.includes(f.match_method))) out.push(`the part was matched by ${f.match_method ?? 'nobody'}`);
  if (when.stock_covers && !f.price?.in_stock) out.push('stock does not cover the quantity');
  if (when.no_flags && f.flags.some((x) => x.severity !== 'info')) out.push('the line has flags');
  if (when.line_total_max_cents !== undefined && (f.price?.line_total_cents ?? Infinity) > when.line_total_max_cents) out.push('the line total is over the limit');
  if (when.categories && (!f.part || !when.categories.includes(f.part.category))) out.push(`${f.part?.category ?? 'this'} is not one of the rule's categories`);
  return out;
}

/** The first auto-approve rule whose conditions all hold, or null. */
export function autoApproveRule(rules: CustomerRules, f: AutoFacts): string | null {
  for (const r of rules.auto_approve) if (!failedConditions(r.when, f).length) return r.name;
  return null;
}
