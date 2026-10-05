// Shared types. Safe to import from client components (no Node imports).

export type Cert = 'CoC' | 'MTR' | 'RoHS' | 'REACH' | 'FAI';
export const CERTS: readonly Cert[] = ['CoC', 'MTR', 'RoHS', 'REACH', 'FAI'];
export type Tier = 'A' | 'B' | 'C';
export type Uom = 'EA' | 'FT' | 'PK';
export type LineStatus = 'draft' | 'approved' | 'rejected';
export type MatchStatus = 'auto' | 'needs_review' | 'resolved';
export type MatchMethod = 'rule' | 'claude' | 'rep';
export type ExportHold = 'marked' | 'screened' | 'catalog';
export type Severity = 'block' | 'warn' | 'info';
export type MissingField = 'qty' | 'due_date' | 'cert_type';

export interface Part {
  sku: string;
  category: string;
  description: string;
  mfr: string;
  mfr_part: string;
  supplier_id: string;
  supplier_part: string;
  uom: 'EA' | 'FT';
  pack_qty: number;
  supplier_moq: number;
  cost_cents: number;
  stock_qty: number;
  lead_time_days: number;
  status: 'active' | 'obsolete';
  superseded_by: string | null;
  export_controlled: boolean;
  certs: Cert[];
  aliases: string[];
}

export interface Supplier {
  id: string;
  name: string;
  email: string;
  phone: string;
  default_lead_days: number;
}

/** What the buyer wrote for one line, as text, before any interpretation. Empty string = not stated. */
export interface Requested {
  part_text: string;
  description: string;
  qty_text: string;
  uom_text: string;
  due_text: string;
  certs_text: string;
  export_text: string;
}

export interface SourceRef {
  doc: string; // attachment file name, or "email body"
  kind: 'xlsx' | 'pdf' | 'body';
  sheet?: string;
  page?: number;
  row?: number; // spreadsheet row number, or line number on the PDF page
  index?: number; // 0-based data row inside a table
  quote: string; // the row's text, or the exact span of free text
}

export interface ExtractedLine {
  source: SourceRef;
  requested: Requested;
  method: 'rule' | 'claude';
  qty: number | null;
  uom: Uom;
  due_date: string | null;
  certs: Cert[];
  certs_unclear: boolean;
  export_marked: boolean;
  screened_term: string | null; // export screening hit, checked before Claude ever sees the text
  missing: MissingField[];
  notes: string[];
}

export interface PricingRules {
  tiers: Record<Tier, { margin_bps: number; label: string }>;
  qty_breaks: { min_qty: number; less_bps: number }[];
  floor_margin_bps: number;
  min_line_cents: number;
  lead_time: { handling_days: number; transit_days: number };
  rush: { handling_days: number; transit_days: number; fee_bps: number; min_fee_cents: number };
  quote_valid_days: number;
}

export interface PriceInput {
  cost_cents: number;
  qty: number;
  pack_qty: number;
  tier: Tier;
  quote_date: string;
  due_date: string | null;
  stock_qty: number;
  lead_time_days: number;
  rush_fee_waived: boolean;
  override_unit_cents?: number | null;
}

export interface PriceResult {
  qty: number;
  billed_qty: number;
  pack_qty: number;
  pack_rounded: boolean;
  cost_cents: number;
  tier: Tier;
  tier_margin_bps: number;
  break_less_bps: number;
  margin_bps: number;
  list_unit_cents: number;
  unit_cents: number;
  overridden: boolean;
  actual_margin_bps: number;
  extended_cents: number;
  min_line_adjust_cents: number;
  rush: boolean;
  rush_fee_waived: boolean;
  rush_fee_cents: number;
  line_total_cents: number;
  cost_total_cents: number;
  in_stock: boolean;
  stock_qty: number;
  lead_time_days: number;
  ship_date: string;
  arrive_date: string;
  partial: { qty: number; arrive_date: string } | null;
  due_date: string | null;
  misses_due: boolean;
}

export type FlagCode =
  | 'EXPORT_CONTROLLED'
  | 'UNKNOWN_PART'
  | 'OBSOLETE_PART'
  | 'SUBSTITUTED'
  | 'MISSING_INFO'
  | 'CERT_UNAVAILABLE'
  | 'PACK_ROUNDED'
  | 'LEAD_TIME_MISS'
  | 'STOCK_SHORT'
  | 'RUSH_FEE'
  | 'MIN_LINE'
  | 'PRICE_OVERRIDE'
  | 'BELOW_FLOOR';

export interface Flag {
  code: FlagCode;
  severity: Severity;
  message: string;
  evidence: string[];
}

export interface Candidate {
  sku: string;
  description: string;
  mfr_part: string;
  score: number;
}

export interface CustomerRules {
  default_certs: Cert[];
  rush_fee_waived: boolean;
  substitutes: 'ask' | 'allow';
  quote_valid_days?: number;
  auto_approve: { name: string; when: AutoWhen }[];
}

export interface AutoWhen {
  match_method?: MatchMethod[];
  stock_covers?: boolean;
  no_flags?: boolean;
  line_total_max_cents?: number;
  categories?: string[];
}

// ---------- the Claude seam ----------

export interface ExtractBlock {
  ref: string;
  doc: string;
  kind: 'pdf' | 'body';
  text: string;
}

export interface ExtractRequest {
  rfq_ref: string; // fixture id; the oracle uses it, the prompt doesn't
  from: string;
  subject: string;
  blocks: ExtractBlock[];
  already_found: string[];
}

export interface ExtractItem {
  block_ref: string;
  quote: string;
  part_text: string;
  description: string;
  qty_text: string;
  uom_text: string;
  due_text: string;
  certs_text: string;
}

export interface ExtractOutput {
  items: ExtractItem[];
  defaults: { quote: string; due_text: string; certs_text: string };
}

export interface MatchItem {
  ref: string;
  rfq_ref: string; // fixture id, for the oracle; never sent to Claude
  request: string;
  reason: 'ambiguous' | 'typo' | 'description';
  candidates: Candidate[];
  source: SourceRef; // for the oracle and the audit trail; never sent to Claude
}

export interface MatchAnswer {
  line_ref: string;
  sku: string; // a candidate SKU, or NONE
  confidence: number;
  evidence: string[];
  why: string;
}

export interface QuestionRequest {
  rfq_ref: string;
  buyer_first_name: string;
  rep_first_name: string;
  rfq_subject: string;
  asks: { line_no: number; buyer_words: string; fields: MissingField[] }[];
}

export interface QuestionOutput {
  subject: string;
  body: string;
}

export interface CallMeta {
  promptVersion: string;
  model: string;
}

export interface LLM {
  name: 'anthropic' | 'oracle';
  extract(req: ExtractRequest): Promise<ExtractOutput & { meta: CallMeta }>;
  match(items: MatchItem[]): Promise<MatchAnswer[]>;
  question(req: QuestionRequest): Promise<QuestionOutput & { meta: CallMeta }>;
}
