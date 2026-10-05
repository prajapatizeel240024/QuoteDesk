// Server-only: loads env files and config/quotedesk.yaml. Never import this from a client component.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { Cert, CustomerRules, PricingRules } from './types';

const CertZ = z.enum(['CoC', 'MTR', 'RoHS', 'REACH', 'FAI']);
const MatchMethodZ = z.enum(['rule', 'claude', 'rep']);

const WhenZ = z.strictObject({
  match_method: z.array(MatchMethodZ).min(1).optional(),
  stock_covers: z.boolean().optional(),
  no_flags: z.boolean().optional(),
  line_total_max_cents: z.number().int().positive().optional(),
  categories: z.array(z.string()).min(1).optional(),
});

const CustomerRulesZ = z.strictObject({
  default_certs: z.array(CertZ).default([]),
  rush_fee_waived: z.boolean().default(false),
  substitutes: z.enum(['ask', 'allow']).default('ask'),
  quote_valid_days: z.number().int().positive().optional(),
  auto_approve: z.array(z.strictObject({ name: z.string().min(3), when: WhenZ })).default([]),
});

const CustomerZ = z.strictObject({
  id: z.string().regex(/^C-\d{4}$/),
  name: z.string(),
  short_name: z.string(),
  tier: z.enum(['A', 'B', 'C']),
  terms: z.string(),
  domains: z.array(z.string()).min(1),
  contacts: z.array(z.strictObject({ name: z.string(), email: z.string(), phone: z.string().optional() })).min(1),
  rules: CustomerRulesZ,
});

const Bps = z.number().int().min(0).max(9_999);
const Days = z.number().int().min(0).max(120);

const PricingZ = z.strictObject({
  tiers: z.strictObject({ A: z.strictObject({ margin_bps: Bps, label: z.string() }), B: z.strictObject({ margin_bps: Bps, label: z.string() }), C: z.strictObject({ margin_bps: Bps, label: z.string() }) }),
  qty_breaks: z.array(z.strictObject({ min_qty: z.number().int().positive(), less_bps: Bps })),
  floor_margin_bps: Bps,
  min_line_cents: z.number().int().min(0),
  lead_time: z.strictObject({ handling_days: Days, transit_days: Days }),
  rush: z.strictObject({ handling_days: Days, transit_days: Days, fee_bps: Bps, min_fee_cents: z.number().int().min(0) }),
  quote_valid_days: z.number().int().positive(),
});

const ConfigZ = z.strictObject({
  distributor: z.strictObject({
    name: z.string(),
    short_name: z.string(),
    domain: z.string(),
    quotes_inbox: z.string(),
    phone: z.string(),
    address: z.string(),
    rep: z.strictObject({ id: z.string().max(8), name: z.string(), title: z.string(), email: z.string() }),
    timezone: z.string(),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  }),
  pricing: PricingZ,
  certs: z.strictObject({
    vocab: z.record(CertZ, z.strictObject({ label: z.string(), synonyms: z.array(z.string()) })),
    unspecified: z.array(z.string()),
    none: z.array(z.string()),
  }),
  extraction: z.strictObject({
    columns: z.strictObject({
      line: z.array(z.string()),
      part: z.array(z.string()),
      description: z.array(z.string()),
      qty: z.array(z.string()),
      uom: z.array(z.string()),
      due: z.array(z.string()),
      certs: z.array(z.string()),
      export: z.array(z.string()),
    }),
    uom: z.strictObject({ EA: z.array(z.string()), FT: z.array(z.string()), PK: z.array(z.string()) }),
    stop_rows: z.array(z.string()),
    export_screen_terms: z.array(z.string()).min(1),
  }),
  matching: z.strictObject({ synonyms: z.record(z.string(), z.string()), stop_words: z.array(z.string()) }),
  customers: z.array(CustomerZ).min(1),
  evals: z.strictObject({
    time_model: z.strictObject({
      manual_minutes_per_rfq: z.number().positive(),
      manual_minutes_per_line: z.number().positive(),
      assisted_minutes_per_rfq: z.number().positive(),
      assisted_minutes_per_clean_line: z.number().positive(),
      assisted_minutes_per_flagged_line: z.number().positive(),
    }),
  }),
});

export type Config = z.infer<typeof ConfigZ>;
export type Customer = Config['customers'][number];

let cached: Config | null = null;
let envLoaded = false;

/** Loads .env.local then .env (variables already set in the environment win). */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  for (const file of ['.env.local', '.env']) {
    const full = path.join(/*turbopackIgnore: true*/ process.cwd(), file);
    if (fs.existsSync(full)) process.loadEnvFile(full);
  }
}

export function loadConfig(): Config {
  if (cached) return cached;
  cached = parseConfig(fs.readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), 'config', 'quotedesk.yaml'), 'utf8'));
  return cached;
}

/** Parses and checks config YAML. Unknown keys anywhere are an error, so a typo in a rule can't be ignored. */
export function parseConfig(raw: string): Config {
  const cfg = ConfigZ.parse(YAML.parse(raw));
  const ids = new Set<string>();
  for (const c of cfg.customers) {
    if (ids.has(c.id)) throw new Error(`config/quotedesk.yaml: customer ${c.id} is listed twice`);
    ids.add(c.id);
  }
  const breaks = cfg.pricing.qty_breaks.map((b) => b.min_qty);
  if (breaks.some((q, i) => i > 0 && q <= breaks[i - 1])) throw new Error('config/quotedesk.yaml: qty_breaks must go up in min_qty');
  for (const t of ['A', 'B', 'C'] as const) {
    if (cfg.pricing.tiers[t].margin_bps < cfg.pricing.floor_margin_bps) throw new Error(`config/quotedesk.yaml: tier ${t} margin is below the floor`);
  }
  return cfg;
}

export function pricingRules(cfg: Config = loadConfig()): PricingRules {
  return cfg.pricing;
}

export function customerById(id: string, cfg: Config = loadConfig()): Customer {
  const c = cfg.customers.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown customer ${id}`);
  return c;
}

export function customerRules(c: Customer): CustomerRules {
  return c.rules as CustomerRules;
}

/** Who sent the RFQ: the sender's domain first, then a company name in the signature. */
export function identifyCustomer(fromEmail: string, body: string, cfg: Config = loadConfig()): { customer: Customer; basis: { method: 'domain' | 'signature'; value: string } } | null {
  const domain = fromEmail.split('@')[1]?.toLowerCase() ?? '';
  const byDomain = cfg.customers.find((c) => c.domains.includes(domain));
  if (byDomain) return { customer: byDomain, basis: { method: 'domain', value: domain } };
  const tail = body.split('\n').slice(-8).join('\n').toLowerCase();
  const bySig = cfg.customers.filter((c) => tail.includes(c.name.toLowerCase()) || tail.includes(c.short_name.toLowerCase()));
  if (bySig.length === 1) return { customer: bySig[0], basis: { method: 'signature', value: bySig[0].name } };
  return null;
}

export function certLabel(c: Cert, cfg: Config = loadConfig()): string {
  return cfg.certs.vocab[c].label;
}
