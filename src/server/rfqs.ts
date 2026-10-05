// Read models for the inbox and the RFQ review screen.
import { customerById, customerRules, loadConfig } from '@/lib/config';
import type { Queryable } from '@/server/db';
import { listFixtures, loadMessage } from '@/server/ingest/fixture';
import { getLineViews, HttpError } from '@/server/lines/service';

export async function getInbox(db: Queryable) {
  const loaded = await db.query<{ fixture_id: string; id: string; status: string; lines: number; needs_you: number; total_cents: string | null }>(
    `select r.fixture_id, r.id, r.status, count(l.id)::int as lines,
            count(l.id) filter (where l.status = 'draft')::int as needs_you,
            sum((l.price->>'line_total_cents')::bigint) filter (where l.status <> 'rejected') as total_cents
       from rfqs r left join quote_lines l on l.rfq_id = r.id group by r.id`,
  );
  const byFixture = new Map(loaded.rows.map((r) => [r.fixture_id, r]));
  const cfg = loadConfig();
  return listFixtures().map((id) => {
    const m = loadMessage(id);
    const row = byFixture.get(id);
    const domain = m.from.email.split('@')[1];
    const customer = cfg.customers.find((c) => c.domains.includes(domain)) ?? cfg.customers.find((c) => m.body.includes(c.name));
    return {
      fixture_id: id,
      received_at: m.received_at,
      from: m.from,
      company: customer?.name ?? null,
      subject: m.subject,
      attachments: m.attachments.map((a) => a.filename),
      rfq_id: row?.id ?? null,
      status: row?.status ?? null,
      lines: row?.lines ?? 0,
      needs_you: row?.needs_you ?? 0,
      total_cents: row?.total_cents ? Number(row.total_cents) : 0,
    };
  });
}

export async function getRfqView(db: Queryable, rfqId: string) {
  const r = await db.query<{ id: string; fixture_id: string; customer_id: string | null; customer_basis: Record<string, string>; from_name: string; from_email: string; subject: string; body: string; received_at: Date; quote_date: string; status: string; run_ms: number | null; defaults: Record<string, unknown> }>(
    'select id, fixture_id, customer_id, customer_basis, from_name, from_email, subject, body, received_at, quote_date, status, run_ms, defaults from rfqs where id = $1',
    [rfqId],
  );
  if (!r.rowCount) throw new HttpError(404, 'That RFQ has not been loaded.');
  const rfq = r.rows[0];
  const cfg = loadConfig();
  const customer = rfq.customer_id ? customerById(rfq.customer_id, cfg) : null;
  const docs = await db.query<{ filename: string; kind: string }>(`select filename, kind from rfq_documents where rfq_id = $1 and kind <> 'body' order by filename`, [rfqId]);
  const lines = await getLineViews(db, { rfqId });
  const question = await db.query<{ subject: string; body: string; status: string; drafted_by: string; version: number; asks: unknown }>('select subject, body, status, drafted_by, version, asks from buyer_questions where rfq_id = $1', [rfqId]);
  const quotes = await db.query<{ quote_number: string; email_subject: string; email_text: string; total_cents: string; created_at: Date }>('select quote_number, email_subject, email_text, total_cents, created_at from quotes where rfq_id = $1 order by created_at desc', [rfqId]);
  const pos = await db.query<{ po_number: string; supplier_id: string; email_text: string; total_cents: string; created_at: Date }>('select po_number, supplier_id, email_text, total_cents, created_at from purchase_orders where rfq_id = $1 order by created_at desc, po_number', [rfqId]);
  const live = lines.filter((l) => l.status !== 'rejected' && l.price);
  const total = live.reduce((s, l) => s + l.price!.line_total_cents, 0);
  const cost = live.reduce((s, l) => s + l.price!.cost_total_cents, 0);
  const rules = customer ? customerRules(customer) : null;
  return {
    rfq: { ...rfq, received_at: rfq.received_at.toISOString(), attachments: docs.rows },
    customer: customer && rules ? { id: customer.id, name: customer.name, short_name: customer.short_name, tier: customer.tier, tier_label: cfg.pricing.tiers[customer.tier].label, terms: customer.terms, rules: { default_certs: rules.default_certs, rush_fee_waived: rules.rush_fee_waived, substitutes: rules.substitutes, auto_approve: rules.auto_approve.map((a) => a.name) } } : null,
    lines,
    question: question.rows[0] ?? null,
    quotes: quotes.rows.map((q) => ({ ...q, total_cents: Number(q.total_cents), created_at: q.created_at.toISOString() })),
    pos: pos.rows.map((p) => ({ ...p, total_cents: Number(p.total_cents), created_at: p.created_at.toISOString() })),
    totals: {
      lines: lines.length,
      approved: lines.filter((l) => l.status === 'approved').length,
      rejected: lines.filter((l) => l.status === 'rejected').length,
      drafts: lines.filter((l) => l.status === 'draft').length,
      held: lines.filter((l) => l.export_hold && !l.export_cleared && l.status === 'draft').length,
      needs_part: lines.filter((l) => l.match_status === 'needs_review' && l.status === 'draft' && !(l.export_hold && !l.export_cleared)).length,
      auto_approved: lines.filter((l) => l.approved_by?.startsWith('rule:')).length,
      total_cents: total,
      approved_cents: lines.filter((l) => l.status === 'approved' && l.price).reduce((s, l) => s + l.price!.line_total_cents, 0),
      rush_cents: live.reduce((s, l) => s + l.price!.rush_fee_cents, 0),
      margin_bps: total ? Math.floor(((total - cost) * 10_000) / total) : 0,
    },
    pricing: { rules: cfg.pricing, holidays: cfg.distributor.holidays, quote_date: rfq.quote_date, tier: customer?.tier ?? 'C', rush_fee_waived: rules?.rush_fee_waived ?? false },
    llm: process.env.LLM_MODE ?? 'anthropic',
    drafted_by: [...new Set(lines.flatMap((l) => l.prompt_versions))],
  };
}

export type RfqView = Awaited<ReturnType<typeof getRfqView>>;
