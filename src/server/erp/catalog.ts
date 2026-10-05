// The ERP export: data/erp/catalog.csv, suppliers.csv and customer_xref.csv. Seeding copies it into
// Postgres; matching reads the parts table, so the database is what the pipeline trusts at run time.
import fs from 'node:fs';
import path from 'node:path';
import type { Cert, Part, Supplier } from '@/lib/types';
import { CERTS } from '@/lib/types';

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
  }
  return rows;
}

export function toCsv(rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\n') + '\n';
}

function records(file: string): Record<string, string>[] {
  const rows = parseCsv(fs.readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'erp', file), 'utf8'));
  const [header, ...body] = rows;
  return body.map((r) => {
    if (r.length !== header.length) throw new Error(`data/erp/${file}: a row has ${r.length} fields, expected ${header.length}`);
    return Object.fromEntries(header.map((h, i) => [h, r[i]]));
  });
}

const int = (v: string, what: string) => {
  if (!/^\d+$/.test(v)) throw new Error(`data/erp/catalog.csv: ${what} "${v}" is not a whole number`);
  return Number(v);
};

export function partFromRecord(r: Record<string, string>): Part {
  const certs = r.certs ? r.certs.split(';').map((c) => c.trim()) : [];
  for (const c of certs) if (!CERTS.includes(c as Cert)) throw new Error(`data/erp/catalog.csv: ${r.sku} lists unknown cert "${c}"`);
  if (r.uom !== 'EA' && r.uom !== 'FT') throw new Error(`data/erp/catalog.csv: ${r.sku} has unit "${r.uom}"`);
  if (r.status !== 'active' && r.status !== 'obsolete') throw new Error(`data/erp/catalog.csv: ${r.sku} has status "${r.status}"`);
  return {
    sku: r.sku,
    category: r.category,
    description: r.description,
    mfr: r.mfr,
    mfr_part: r.mfr_part,
    supplier_id: r.supplier_id,
    supplier_part: r.supplier_part,
    uom: r.uom,
    pack_qty: int(r.pack_qty, 'pack_qty'),
    supplier_moq: int(r.supplier_moq, 'supplier_moq'),
    cost_cents: int(r.cost_cents, 'cost_cents'),
    stock_qty: int(r.stock_qty, 'stock_qty'),
    lead_time_days: int(r.lead_time_days, 'lead_time_days'),
    status: r.status,
    superseded_by: r.superseded_by || null,
    export_controlled: r.export_controlled === 'Y',
    certs: certs as Cert[],
    aliases: r.aliases ? r.aliases.split(';').map((a) => a.trim()).filter(Boolean) : [],
  };
}

let cache: { parts: Part[]; suppliers: Supplier[]; xref: { customer_id: string; customer_pn: string; sku: string }[] } | null = null;

export function loadErpExport() {
  if (cache) return cache;
  const parts = records('catalog.csv').map(partFromRecord);
  const skus = new Set(parts.map((p) => p.sku));
  for (const p of parts) if (p.superseded_by && !skus.has(p.superseded_by)) throw new Error(`data/erp/catalog.csv: ${p.sku} is superseded by unknown ${p.superseded_by}`);
  const suppliers: Supplier[] = records('suppliers.csv').map((r) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone, default_lead_days: int(r.default_lead_days, 'default_lead_days') }));
  const xref = records('customer_xref.csv').map((r) => ({ customer_id: r.customer_id, customer_pn: r.customer_pn, sku: r.sku }));
  for (const x of xref) if (!skus.has(x.sku)) throw new Error(`data/erp/customer_xref.csv: ${x.customer_pn} points at unknown ${x.sku}`);
  cache = { parts, suppliers, xref };
  return cache;
}
