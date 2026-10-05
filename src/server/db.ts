// Postgres access: pooled connections, transactions, migrations and seeding. Local hosts only.
import fs from 'node:fs';
import path from 'node:path';
import pg, { Client, Pool, type PoolClient } from 'pg';
import { loadConfig, loadEnv } from '@/lib/config';
import { loadErpExport } from '@/server/erp/catalog';

// DATE columns come back as 'YYYY-MM-DD' strings, never as local-midnight Date objects.
pg.types.setTypeParser(1082, (v: string) => v);
// numeric (match_confidence) comes back as a number.
pg.types.setTypeParser(1700, (v: string) => Number(v));

export type Queryable = Pool | PoolClient;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Refusing to use database host "${host}". QuoteDesk only talks to local Postgres.`);
}

export function dbUrl(which: 'dev' | 'eval' = 'dev'): string {
  loadEnv();
  const url = which === 'eval' ? process.env.EVAL_DATABASE_URL : process.env.DATABASE_URL;
  const name = which === 'eval' ? 'EVAL_DATABASE_URL' : 'DATABASE_URL';
  if (!url) throw new Error(`${name} is not set. Copy .env.example to .env.local.`);
  assertLocal(url);
  return url;
}

const g = globalThis as unknown as { __quotedeskPools?: Map<string, Pool> };

export function getPool(url: string = dbUrl('dev')): Pool {
  assertLocal(url);
  g.__quotedeskPools ??= new Map();
  let pool = g.__quotedeskPools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 6 });
    g.__quotedeskPools.set(url, pool);
  }
  return pool;
}

export async function closePools(): Promise<void> {
  const pools = [...(g.__quotedeskPools?.values() ?? [])];
  g.__quotedeskPools?.clear();
  await Promise.all(pools.map((p) => p.end()));
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Creates the database named in the URL if it doesn't exist yet (needs CREATEDB). */
export async function ensureDatabase(url: string): Promise<void> {
  assertLocal(url);
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error(`Unexpected database name "${dbName}"`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const found = await client.query('select 1 from pg_database where datname = $1', [dbName]);
    if (!found.rowCount) await client.query(`create database ${dbName}`);
  } finally {
    await client.end();
  }
}

export async function migrate(url: string): Promise<string[]> {
  await ensureDatabase(url);
  const pool = getPool(url);
  await pool.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const dir = path.join(/*turbopackIgnore: true*/ process.cwd(), 'db', 'migrations');
  const applied: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const done = await pool.query('select 1 from schema_migrations where name = $1', [file]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await withTx(pool, async (c) => {
      await c.query(sql);
      await c.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

/** Copies the ERP export and the customers in config/quotedesk.yaml into Postgres. */
export async function seed(url: string): Promise<{ parts: number; customers: number }> {
  const cfg = loadConfig();
  const erp = loadErpExport();
  await withTx(getPool(url), async (c) => {
    for (const s of erp.suppliers) {
      await c.query(
        `insert into suppliers (id, name, email, phone, default_lead_days) values ($1,$2,$3,$4,$5)
         on conflict (id) do update set name = excluded.name, email = excluded.email, phone = excluded.phone, default_lead_days = excluded.default_lead_days`,
        [s.id, s.name, s.email, s.phone, s.default_lead_days],
      );
    }
    for (const p of erp.parts) {
      await c.query(
        `insert into parts (sku, category, description, mfr, mfr_part, supplier_id, supplier_part, uom, pack_qty, supplier_moq, cost_cents,
                            stock_qty, lead_time_days, status, superseded_by, export_controlled, certs, aliases, synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
         on conflict (sku) do update set category = excluded.category, description = excluded.description, mfr = excluded.mfr,
           mfr_part = excluded.mfr_part, supplier_id = excluded.supplier_id, supplier_part = excluded.supplier_part, uom = excluded.uom,
           pack_qty = excluded.pack_qty, supplier_moq = excluded.supplier_moq, cost_cents = excluded.cost_cents, stock_qty = excluded.stock_qty,
           lead_time_days = excluded.lead_time_days, status = excluded.status, superseded_by = excluded.superseded_by,
           export_controlled = excluded.export_controlled, certs = excluded.certs, aliases = excluded.aliases, synced_at = now()`,
        [p.sku, p.category, p.description, p.mfr, p.mfr_part, p.supplier_id, p.supplier_part, p.uom, p.pack_qty, p.supplier_moq, p.cost_cents,
          p.stock_qty, p.lead_time_days, p.status, p.superseded_by, p.export_controlled, p.certs, p.aliases],
      );
    }
    for (const cu of cfg.customers) {
      await c.query(
        `insert into customers (id, name, short_name, tier, terms, card, rules) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (id) do update set name = excluded.name, short_name = excluded.short_name, tier = excluded.tier,
           terms = excluded.terms, card = excluded.card, rules = excluded.rules`,
        [cu.id, cu.name, cu.short_name, cu.tier, cu.terms, JSON.stringify({ domains: cu.domains, contacts: cu.contacts }), JSON.stringify(cu.rules)],
      );
    }
    await c.query('delete from customer_xref');
    for (const x of erp.xref) await c.query('insert into customer_xref (customer_id, customer_pn, sku) values ($1,$2,$3)', [x.customer_id, x.customer_pn, x.sku]);
  });
  return { parts: erp.parts.length, customers: cfg.customers.length };
}

/** Empties the app tables. Keeps llm_calls (the Claude response cache) unless all=true. */
export async function resetDb(url: string, opts: { all?: boolean } = {}): Promise<void> {
  const tables = ['purchase_orders', 'quotes', 'audit_events', 'buyer_questions', 'line_flags', 'quote_lines', 'rfq_documents', 'rfqs', 'customer_xref', 'customers', 'parts', 'suppliers'];
  if (opts.all) tables.push('llm_calls');
  // TRUNCATE skips row triggers, which is acceptable only because assertLocal() guards every URL.
  await getPool(url).query(`truncate ${tables.join(', ')} restart identity cascade`);
  await seed(url);
}
