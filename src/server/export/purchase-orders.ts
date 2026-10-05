// Draft purchase orders for approved lines that stock doesn't cover: the shortfall, rounded up to each
// supplier's order multiple, grouped by supplier. Code only. Drafts are saved, never sent.
import type { Pool } from 'pg';
import { loadConfig } from '@/lib/config';
import { addBusinessDays, subtractBusinessDays } from '@/lib/dates';
import { money, shortDate } from '@/lib/format';
import { withTx } from '@/server/db';
import { audit } from '@/server/lines/audit';
import { ceilDiv } from '@/server/pricing/engine';
import { getLineViews, HttpError } from '@/server/lines/service';

export interface PoLine {
  line_no: number;
  sku: string;
  supplier_part: string;
  description: string;
  shortfall: number;
  order_qty: number;
  uom: string;
  unit_cost_cents: number;
  extended_cents: number;
  needed_by: string;
}

export interface PoDraft {
  po_number: string;
  supplier_id: string;
  supplier_name: string;
  supplier_email: string;
  lines: PoLine[];
  total_cents: number;
  text: string;
}

export async function draftPurchaseOrders(pool: Pool, rfqId: string, actor: string): Promise<PoDraft[]> {
  const rfq = await pool.query<{ quote_date: string; subject: string }>('select quote_date, subject from rfqs where id = $1', [rfqId]);
  if (!rfq.rowCount) throw new HttpError(404, 'That RFQ has not been loaded.');
  const cfg = loadConfig();
  const lt = cfg.pricing.lead_time;
  const short = (await getLineViews(pool, { rfqId })).filter((l) => l.status === 'approved' && l.price && l.part && !l.price.in_stock);
  if (!short.length) throw new HttpError(422, 'Every approved line ships from stock, so no purchase orders are needed.');
  const suppliers = await pool.query<{ id: string; name: string; email: string }>('select id, name, email from suppliers');
  const bySupplier = new Map<string, PoLine[]>();
  for (const l of short) {
    const p = l.price!;
    const part = l.part!;
    const shortfall = p.billed_qty - p.stock_qty;
    const order = ceilDiv(shortfall, part.supplier_moq) * part.supplier_moq;
    const neededBy = p.due_date ? subtractBusinessDays(p.due_date, lt.handling_days + lt.transit_days, cfg.distributor.holidays) : addBusinessDays(rfq.rows[0].quote_date, part.lead_time_days, cfg.distributor.holidays);
    const pl: PoLine = { line_no: l.line_no, sku: part.sku, supplier_part: part.supplier_part, description: part.description, shortfall, order_qty: order, uom: part.uom, unit_cost_cents: part.cost_cents, extended_cents: order * part.cost_cents, needed_by: neededBy };
    bySupplier.set(part.supplier_id, [...(bySupplier.get(part.supplier_id) ?? []), pl]);
  }
  const date = rfq.rows[0].quote_date.replace(/-/g, '');
  return withTx(pool, async (c) => {
    const drafts: PoDraft[] = [];
    for (const [supplierId, lines] of [...bySupplier].sort(([a], [b]) => a.localeCompare(b))) {
      const s = suppliers.rows.find((x) => x.id === supplierId)!;
      const base = `PO-${supplierId.slice(2)}-${date}`;
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [base]);
      const taken = await c.query<{ n: number }>('select count(*)::int as n from purchase_orders where po_number like $1', [`${base}%`]);
      const poNumber = `${base}-${taken.rows[0].n + 1}`;
      const total = lines.reduce((sum, l) => sum + l.extended_cents, 0);
      const text = [
        `Subject: Purchase order ${poNumber} (draft)`,
        '',
        `Hello ${s.name} team,`,
        '',
        'Please confirm the order below and your ship date.',
        '',
        ...lines.flatMap((l, i) => [`${i + 1}. ${l.supplier_part}  ${l.description}`, `   ${l.order_qty.toLocaleString('en-US')} ${l.uom} at ${money(l.unit_cost_cents)} = ${money(l.extended_cents)}. Needed at our dock by ${shortDate(l.needed_by)}.`, '']),
        `Total: ${money(total)}`,
        '',
        `Ship to: ${cfg.distributor.name}, Receiving, ${cfg.distributor.address}`,
        '',
        'Thanks,',
        cfg.distributor.rep.name,
        `${cfg.distributor.name} | ${cfg.distributor.phone}`,
      ].join('\n');
      const ins = await c.query<{ id: string }>('insert into purchase_orders (rfq_id, supplier_id, po_number, lines, total_cents, email_text) values ($1,$2,$3,$4,$5,$6) returning id', [rfqId, supplierId, poNumber, JSON.stringify(lines), total, text]);
      await audit(c, { subject_type: 'po', subject_id: ins.rows[0].id, actor, action: 'drafted', after: { po_number: poNumber, supplier: supplierId, lines: lines.map((l) => `${l.sku} x ${l.order_qty}`), total_cents: total } });
      drafts.push({ po_number: poNumber, supplier_id: supplierId, supplier_name: s.name, supplier_email: s.email, lines, total_cents: total, text });
    }
    return drafts;
  });
}
