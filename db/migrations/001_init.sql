-- QuoteDesk schema. Quote lines and their history are the core; audit_events refuses
-- UPDATE and DELETE at the database level, not by convention.

create table suppliers (
  id                text primary key,              -- 'S-TAL'
  name              text not null,
  email             text not null,
  phone             text not null,
  default_lead_days integer not null check (default_lead_days >= 0)
);

create table parts (                              -- the last ERP export (data/erp/catalog.csv)
  sku               text primary key,             -- 'AF-10117'
  category          text not null,
  description       text not null,
  mfr               text not null,
  mfr_part          text not null,
  supplier_id       text not null references suppliers(id),
  supplier_part     text not null,
  uom               text not null check (uom in ('EA','FT')),
  pack_qty          integer not null check (pack_qty >= 1),
  supplier_moq      integer not null check (supplier_moq >= 1),
  cost_cents        integer not null check (cost_cents > 0),
  stock_qty         integer not null check (stock_qty >= 0),
  lead_time_days    integer not null check (lead_time_days >= 0),
  status            text not null check (status in ('active','obsolete')),
  superseded_by     text references parts(sku) deferrable initially deferred,
  export_controlled boolean not null default false,
  certs             text[] not null default '{}',
  aliases           text[] not null default '{}',
  synced_at         timestamptz not null default now()
);

create table customers (
  id         text primary key,                     -- 'C-1001'
  name       text not null,
  short_name text not null,
  tier       text not null check (tier in ('A','B','C')),
  terms      text not null,
  card       jsonb not null,                       -- domains, contacts
  rules      jsonb not null                        -- automation rules from config/quotedesk.yaml
);

create table customer_xref (                      -- customer part numbers from the ERP
  customer_id text not null references customers(id),
  customer_pn text not null,
  sku         text not null references parts(sku),
  primary key (customer_id, customer_pn)
);

create table rfqs (
  id             uuid primary key default gen_random_uuid(),
  fixture_id     text not null unique,              -- 'rfq-03'
  customer_id    text references customers(id),
  customer_basis jsonb not null default '{}',       -- how the customer was identified
  from_name      text not null,
  from_email     text not null,
  subject        text not null,
  body           text not null,
  received_at    timestamptz not null,
  quote_date     date not null,
  defaults       jsonb not null default '{}',       -- need-by date or certs the email applies to every line
  status         text not null default 'ingested' check (status in ('ingested','drafted','quoted','failed')),
  run_started_at timestamptz,
  run_ms         integer,
  created_at     timestamptz not null default now()
);

create table rfq_documents (
  id       uuid primary key default gen_random_uuid(),
  rfq_id   uuid not null references rfqs(id),
  filename text not null,
  kind     text not null check (kind in ('body','xlsx','pdf')),
  sha256   text not null,
  parsed   jsonb not null,                          -- sheets and rows, or PDF lines with x positions
  unique (rfq_id, filename)
);

create table quote_lines (
  id                    uuid primary key default gen_random_uuid(),
  rfq_id                uuid not null references rfqs(id),
  line_no               integer not null check (line_no > 0),
  source                jsonb not null,             -- document, row or quote: powers "Why this line"
  requested             jsonb not null,             -- the buyer's words, field by field
  extraction_method     text not null check (extraction_method in ('rule','claude')),
  notes                 text[] not null default '{}',
  qty                   integer check (qty > 0),
  uom                   text not null default 'EA' check (uom in ('EA','FT','PK')),
  due_date              date,
  certs                 text[] not null default '{}',
  certs_unclear         boolean not null default false,
  missing               text[] not null default '{}',
  part_sku              text references parts(sku),
  requested_sku         text references parts(sku), -- what was asked for, when a replacement was used
  match_method          text check (match_method in ('rule','claude','rep')),
  match_status          text not null check (match_status in ('auto','needs_review','resolved')),
  match_confidence      numeric(4,3),
  match_evidence        jsonb not null default '[]',
  match_suggestion      jsonb,                      -- Claude's answer, kept even when it didn't clear the bar
  candidates            jsonb not null default '[]',
  claude_said_none      boolean not null default false,
  not_carried           boolean not null default false,
  export_hold           text check (export_hold in ('marked','screened','catalog')),
  export_term           text,                       -- the screening term that matched, if any
  export_cleared        jsonb,                      -- who cleared the hold and why
  price                 jsonb,                      -- computed by code; null when the line can't be priced
  price_override_cents  integer check (price_override_cents > 0),
  price_override_reason text,
  status                text not null default 'draft' check (status in ('draft','approved','rejected')),
  status_reason         text,
  approved_by           text,
  prompt_versions       text[] not null default '{}',
  version               integer not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (rfq_id, line_no)
);

create table line_flags (                         -- current flags; history is in audit_events
  id              bigserial primary key,
  line_id         uuid not null references quote_lines(id),
  code            text not null,
  severity        text not null check (severity in ('block','warn','info')),
  message         text not null,
  evidence        jsonb not null default '[]',
  override_reason text
);

create table buyer_questions (
  id         uuid primary key default gen_random_uuid(),
  rfq_id     uuid not null unique references rfqs(id),
  asks       jsonb not null,                        -- line numbers and missing fields, computed by code
  subject    text not null,
  body       text not null,
  drafted_by text not null,                         -- 'claude:question.v1' or 'template'
  status     text not null default 'draft' check (status in ('draft','sent')),
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_events (
  id           bigserial primary key,
  subject_type text not null check (subject_type in ('line','rfq','question','quote','po')),
  subject_id   text not null,
  version      integer,
  actor        text not null,                       -- 'system', 'claude:match.v1', 'rep:MO', 'rule:C-1001/...'
  action       text not null,
  before       jsonb,
  after        jsonb,
  reason       text,
  created_at   timestamptz not null default now()
);

create function audit_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end;
$$;

create trigger audit_events_no_change
  before update or delete on audit_events
  for each row execute function audit_events_append_only();

create table llm_calls (                          -- every Claude call; doubles as the response cache
  id             bigserial primary key,
  purpose        text not null check (purpose in ('extract','match','question')),
  model          text not null,
  prompt_version text not null,
  cache_key      text not null,
  request        jsonb not null,
  response       jsonb,
  stop_reason    text,
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer,
  created_at     timestamptz not null default now()
);

create table quotes (
  id            uuid primary key default gen_random_uuid(),
  rfq_id        uuid not null references rfqs(id),
  quote_number  text not null unique,
  line_ids      uuid[] not null,
  total_cents   bigint not null,
  email_subject text not null,
  email_text    text not null,
  created_at    timestamptz not null default now()
);

create table purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  rfq_id      uuid not null references rfqs(id),
  supplier_id text not null references suppliers(id),
  po_number   text not null unique,
  lines       jsonb not null,
  total_cents bigint not null,
  email_text  text not null,
  created_at  timestamptz not null default now()
);

create index on rfq_documents (rfq_id);
create index on quote_lines (rfq_id);
create index on quote_lines (match_status);
create index on line_flags (line_id);
create index on audit_events (subject_type, subject_id, id);
create index on llm_calls (cache_key);
