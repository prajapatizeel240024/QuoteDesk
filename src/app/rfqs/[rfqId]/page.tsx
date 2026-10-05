'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, button } from '@/components/bits';
import { HistoryDrawer, SourcesDrawer, TextDrawer } from '@/components/Drawers';
import { LineRow } from '@/components/LineRow';
import { ExportPanel, NeedsPartPanel, QuestionPanel } from '@/components/Panels';
import { longDate, money, pct, plural } from '@/lib/format';
import type { LineView } from '@/server/lines/service';
import type { PipelineEvent } from '@/server/pipeline';
import type { RfqView } from '@/server/rfqs';

type DrawerState = { kind: 'sources' | 'history'; id: string } | { kind: 'text'; title: string; note?: string; docs: { name: string; text: string }[] } | null;

const received = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

export default function RfqPage() {
  const { rfqId } = useParams<{ rfqId: string }>();
  const [view, setView] = useState<RfqView | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const started = useRef(false);

  const load = useCallback(async () => {
    const v = await api<RfqView>(`/api/rfqs/${rfqId}`);
    setView(v);
    return v;
  }, [rfqId]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/rfqs/${rfqId}/run`, { method: 'POST' });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!chunk.startsWith('data: ')) continue;
          const e = JSON.parse(chunk.slice(6)) as PipelineEvent;
          if (e.type === 'stage') setStage(e.message);
          if (e.type === 'summary') setStage(`${plural(e.lines, 'line')}: ${e.matched} matched, ${e.needs_part} need a part, ${e.held} held, ${e.auto_approved} approved by customer rules.`);
          if (e.type === 'line') setView((v) => (v ? { ...v, lines: [...v.lines.filter((x) => x.id !== e.line.id), e.line].sort((a, b) => a.line_no - b.line_no) } : v));
          if (e.type === 'error') setError(e.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
      setStage(null);
      await load().catch(() => undefined);
    }
  }, [rfqId, load]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    load()
      .then((v) => (v.rfq.status === 'ingested' || v.rfq.status === 'failed' ? run() : undefined))
      .catch((err: Error) => setError(err.message));
  }, [load, run]);

  async function act(fn: () => Promise<unknown>) {
    await fn();
    await load();
  }

  async function generateQuote() {
    setError(null);
    try {
      const q = await api<{ quote_number: string; subject: string; text: string }>(`/api/rfqs/${rfqId}/quote`, 'POST');
      setDrawer({ kind: 'text', title: `Quote ${q.quote_number}`, note: `Subject: ${q.subject}. Built by code from the approved lines. Nothing has been sent.`, docs: [{ name: q.quote_number, text: `Subject: ${q.subject}\n\n${q.text}` }] });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function draftPos() {
    setError(null);
    try {
      const d = await api<{ pos: { po_number: string; supplier_name: string; text: string }[] }>(`/api/rfqs/${rfqId}/pos`, 'POST');
      setDrawer({ kind: 'text', title: 'Supplier purchase orders', note: 'Drafts for the parts stock doesn’t cover. Send them once the customer orders.', docs: d.pos.map((p) => ({ name: `${p.po_number} ${p.supplier_name}`, text: p.text })) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!view) {
    return (
      <main>
        <Link href="/" className="text-sm text-ink-soft hover:underline">Inbox</Link>
        {error ? <p role="alert" className="mt-6 text-hold">{error}</p> : <p className="mt-6 text-ink-soft">Loading the request…</p>}
      </main>
    );
  }

  const { rfq, customer, totals } = view;
  const held = (l: LineView) => Boolean(l.export_hold && !l.export_cleared);
  const needsPart = view.lines.filter((l) => l.status === 'draft' && l.match_status === 'needs_review' && !held(l));
  const holds = view.lines.filter((l) => l.status === 'draft' && held(l));
  const shortLines = view.lines.filter((l) => l.status === 'approved' && l.price && !l.price.in_stock);
  const lineActions = (l: LineView) => ({
    approve: (reason?: string) => act(() => api(`/api/lines/${l.id}/approve`, 'POST', { version: l.version, ...(reason ? { override_reason: reason } : {}) })),
    reject: (reason: string) => act(() => api(`/api/lines/${l.id}/reject`, 'POST', { version: l.version, reason })),
    reopen: () => act(() => api(`/api/lines/${l.id}/reopen`, 'POST', { version: l.version })),
    save: (patch: Record<string, unknown>) => act(() => api(`/api/lines/${l.id}`, 'PATCH', { version: l.version, ...patch })),
    showSources: () => setDrawer({ kind: 'sources', id: l.id }),
    showHistory: () => setDrawer({ kind: 'history', id: l.id }),
  });

  return (
    <main>
      <Link href="/" className="text-sm text-ink-soft hover:underline">Inbox</Link>
      <h1 className="din mt-3 text-4xl font-bold tracking-tight sm:text-5xl">{rfq.subject}</h1>
      <p className="mt-2 max-w-3xl text-ink-soft">
        From {rfq.from_name}{customer ? `, ${customer.name}` : ` (${rfq.from_email})`}. Received {received(rfq.received_at)}; quote date {longDate(rfq.quote_date)}.
        {customer && ` Tier ${customer.tier}, ${customer.tier_label.toLowerCase()}, ${customer.terms}.`}
        {rfq.customer_basis?.method === 'signature' && ' Identified from the email signature, since it came from a personal address.'}
      </p>
      {customer && (customer.rules.default_certs.length > 0 || customer.rules.auto_approve.length > 0 || customer.rules.rush_fee_waived || customer.rules.substitutes === 'allow') && (
        <p className="mt-1 text-sm text-ink-soft">
          Customer rules:{customer.rules.default_certs.length > 0 && ` always include ${customer.rules.default_certs.join(', ')};`}
          {customer.rules.substitutes === 'allow' && ' replacements for obsolete parts are fine;'}
          {customer.rules.rush_fee_waived && ' rush fees waived;'}
          {customer.rules.auto_approve.length > 0 && ` auto-approve "${customer.rules.auto_approve.join('", "')}".`}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {rfq.attachments.map((a) => <a key={a.filename} href={`/api/rfqs/${rfq.id}/attachments/${encodeURIComponent(a.filename)}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">{a.filename}</a>)}
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-soft">The email</summary>
          <pre className="mt-2 max-w-2xl whitespace-pre-wrap rounded-sm border border-rule-soft bg-sheet px-4 py-3 font-[family-name:var(--font-ui)] text-sm">{rfq.body}</pre>
        </details>
      </div>

      {running && <p role="status" className="mt-5 text-sm">{stage ?? 'Starting…'}</p>}
      {error && (
        <p role="alert" className="mt-5 rounded-sm border border-hold/40 bg-hold-tint px-4 py-3 text-sm text-hold">
          {error}
          {!running && rfq.status === 'failed' && <button onClick={run} className="ml-3 font-medium underline underline-offset-2">Try again</button>}
        </p>
      )}

      <section aria-label="Quote summary" className="mt-7 flex flex-wrap items-end justify-between gap-6 border-y-2 border-ink bg-sheet px-5 py-4">
        <div>
          <div className="text-sm text-ink-soft">Quote total</div>
          <div className="din figures text-4xl font-bold">{money(totals.total_cents)}</div>
        </div>
        <dl className="figures grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div><dt className="text-ink-soft">Approved</dt><dd>{totals.approved} of {totals.lines} lines</dd></div>
          <div><dt className="text-ink-soft">Margin</dt><dd>{pct(totals.margin_bps)}</dd></div>
          <div><dt className="text-ink-soft">Need you</dt><dd className={totals.drafts ? 'text-warn' : ''}>{totals.drafts ? plural(totals.drafts, 'line') : 'Nothing'}</dd></div>
          <div><dt className="text-ink-soft">Rush fees</dt><dd>{money(totals.rush_cents)}</dd></div>
        </dl>
        <div className="flex flex-wrap gap-3">
          <button onClick={draftPos} disabled={!shortLines.length} title={shortLines.length ? 'Draft purchase orders for approved lines that stock doesn’t cover' : 'No approved line needs more stock'} className={button.secondary}>Draft supplier POs</button>
          <button onClick={generateQuote} disabled={totals.drafts > 0 || totals.approved === 0} title={totals.drafts ? 'Approve or leave out every line first' : 'Build the quote email from the approved lines'} className={button.primary}>Generate quote email</button>
        </div>
        {view.quotes[0] && (
          <p className="basis-full text-sm">
            Quote {view.quotes[0].quote_number} generated for {money(view.quotes[0].total_cents)}.{' '}
            <button className="underline underline-offset-2" onClick={() => setDrawer({ kind: 'text', title: `Quote ${view.quotes[0].quote_number}`, docs: [{ name: view.quotes[0].quote_number, text: `Subject: ${view.quotes[0].email_subject}\n\n${view.quotes[0].email_text}` }] })}>View the email</button>
          </p>
        )}
      </section>

      <NeedsPartPanel lines={needsPart} customerId={customer?.id ?? ''} onResolve={(l, choice) => act(() => api(`/api/lines/${l.id}/resolve`, 'POST', { version: l.version, ...choice }))} />
      <ExportPanel lines={holds} onClear={(l, reviewer, reason) => act(() => api(`/api/lines/${l.id}/clear-export`, 'POST', { version: l.version, reviewer, reason }))} onLeaveOut={(l) => act(() => api(`/api/lines/${l.id}/reject`, 'POST', { version: l.version, reason: 'Held for export review' }))} />
      {view.question && <QuestionPanel key={view.question.version} question={view.question} onSave={(patch) => act(() => api(`/api/rfqs/${rfq.id}/question`, 'PATCH', { version: view.question!.version, ...patch }))} />}

      <section aria-labelledby="lines" className="mt-10">
        <h2 id="lines" className="din border-b-2 border-ink pb-1 text-2xl font-semibold">Lines</h2>
        {view.lines.length === 0 && !running && <p className="mt-4 text-ink-soft">{rfq.status === 'failed' ? 'The draft failed. See the message above.' : 'No lines yet.'}</p>}
        <ul className="border-x border-b border-rule bg-sheet">
          {view.lines.map((l) => <LineRow key={`${l.id}:${l.version}`} line={l} pricing={view.pricing} customerId={customer?.id ?? ''} actions={lineActions(l)} />)}
        </ul>
      </section>

      <footer className="mt-12 border-t border-rule pt-4 text-xs text-ink-soft">
        Prices come from code: cost from the ERP export, the customer&apos;s tier margin, quantity breaks, rush and minimum-line rules. Claude reads free text and helps match hard parts; it never sets a price.
        {view.llm === 'oracle' || view.drafted_by.includes('oracle') ? ' Claude calls on this RFQ were answered by the answer-key stand-in, for testing only.' : ''}
        {rfq.run_ms !== null && ` Drafted in ${(rfq.run_ms / 1000).toFixed(1)} s.`} Synthetic data only.
      </footer>

      {drawer?.kind === 'sources' && <SourcesDrawer lineId={drawer.id} onClose={() => setDrawer(null)} />}
      {drawer?.kind === 'history' && <HistoryDrawer lineId={drawer.id} onClose={() => setDrawer(null)} />}
      {drawer?.kind === 'text' && <TextDrawer title={drawer.title} note={drawer.note} docs={drawer.docs} onClose={() => setDrawer(null)} />}
    </main>
  );
}
