'use client';

import { useEffect, useState } from 'react';
import { money, pct, shortDate } from '@/lib/format';
import type { Candidate, MatchAnswer, PriceResult, Requested, SourceRef } from '@/lib/types';
import { CopyButton, Drawer, PartLabel, button } from './bits';

interface Sources {
  line_no: number;
  source: SourceRef;
  requested: Requested;
  extraction_method: 'rule' | 'claude';
  notes: string[];
  context: { kind: 'table'; header: string[]; row: string[] } | { kind: 'text'; before: string; quote: string; after: string } | null;
  match: { method: string | null; status: string; confidence: number | null; evidence: { signal: string; value: string }[]; suggestion: MatchAnswer | null; candidates: Candidate[]; claude_said_none: boolean };
  export: { hold: string | null; term: string | null; cleared: { by: string; reason: string; at: string } | null };
  price: PriceResult | null;
  prompt_versions: string[];
}

const SIGNALS: Record<string, string> = { sku: 'our SKU', mfr_part: 'manufacturer part number', alias: 'old part number', customer_pn: "customer's part number", claude_quote: 'Claude quoted', size_conflict: 'size not in the part', export_hold: 'held' };

export function SourcesDrawer({ lineId, onClose }: { lineId: string; onClose: () => void }) {
  const [s, setS] = useState<Sources | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/lines/${lineId}/sources`).then(async (r) => (r.ok ? setS(await r.json()) : setError((await r.json()).error)));
  }, [lineId]);
  const p = s?.price;
  return (
    <Drawer title={s ? `Why line ${s.line_no}` : 'Why this line'} onClose={onClose}>
      {error && <p role="alert" className="mt-4 text-hold">{error}</p>}
      {s && (
        <div className="mt-4 space-y-6 text-sm">
          <section>
            <h3 className="din text-lg font-semibold">Where it came from</h3>
            <p className="mt-1 text-ink-soft">{s.source.doc}{s.source.kind === 'xlsx' ? `, sheet ${s.source.sheet}, row ${s.source.row}` : ''}. {s.extraction_method === 'claude' ? 'Claude read it from free text; every field was checked against the email.' : 'Read by rules.'}</p>
            {s.context?.kind === 'table' && (
              <div className="mt-2 overflow-x-auto">
                <table className="text-xs">
                  <thead><tr>{s.context.header.map((h, i) => <th key={i} className="border border-rule bg-note px-2 py-1 text-left font-medium">{h}</th>)}</tr></thead>
                  <tbody><tr>{s.context.row.map((c, i) => <td key={i} className="border border-rule px-2 py-1">{c}</td>)}</tr></tbody>
                </table>
              </div>
            )}
            {s.context?.kind === 'text' && <p className="mt-2 whitespace-pre-wrap rounded-sm bg-note px-3 py-2 text-xs leading-relaxed">…{s.context.before}<mark className="bg-label px-0.5">{s.context.quote}</mark>{s.context.after}…</p>}
            {s.notes.length > 0 && <ul className="mt-2 list-disc pl-5 text-ink-soft">{s.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          </section>
          <section>
            <h3 className="din text-lg font-semibold">How the part was matched</h3>
            {s.export.hold && <p className="mt-1">{s.export.hold === 'screened' ? `Export screening matched "${s.export.term}" before anything went to Claude.` : s.export.hold === 'marked' ? 'The buyer marked the line export-controlled.' : 'The ERP flags this part export-controlled.'}{s.export.cleared ? ` Cleared by ${s.export.cleared.by}: ${s.export.cleared.reason}` : ''}</p>}
            <p className="mt-1">{s.match.method === 'rule' ? 'A rule found an exact part number.' : s.match.method === 'claude' ? `Claude picked it at ${Math.round((s.match.confidence ?? 0) * 100)}%, and the pick cleared the bar: a listed candidate, quotes that really appear in the request, no size conflict.` : s.match.method === 'rep' ? 'Chosen by the rep.' : 'No part matched with enough confidence.'}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">{s.match.evidence.map((e, i) => <span key={i} className="rounded-sm bg-note px-1.5 py-0.5 text-xs">{SIGNALS[e.signal] ?? e.signal}: {e.value}</span>)}</div>
            {s.match.suggestion && <p className="mt-2 text-ink-soft">Claude said {s.match.suggestion.sku} at {Math.round(s.match.suggestion.confidence * 100)}%: {s.match.suggestion.why}</p>}
            {s.match.candidates.length > 0 && <ul className="mt-2 space-y-1">{s.match.candidates.map((c) => <li key={c.sku} className="flex flex-wrap items-center gap-2"><PartLabel sku={c.sku} /><span>{c.description}</span><span className="text-xs text-ink-soft">score {c.score}</span></li>)}</ul>}
          </section>
          <section>
            <h3 className="din text-lg font-semibold">How the price was built</h3>
            {p ? (
              <dl className="figures mt-2 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1">
                <dt>Cost</dt><dd className="text-right">{money(p.cost_cents)}</dd>
                <dt>Tier {p.tier} margin</dt><dd className="text-right">{pct(p.tier_margin_bps)}</dd>
                {p.break_less_bps > 0 && <><dt>Quantity break at {p.billed_qty.toLocaleString('en-US')}</dt><dd className="text-right">-{pct(p.break_less_bps)}</dd></>}
                <dt>Unit price: cost / (1 - {pct(p.margin_bps)}), rounded up</dt><dd className="text-right">{money(p.list_unit_cents)}</dd>
                {p.overridden && <><dt>Set by hand</dt><dd className="text-right">{money(p.unit_cents)}</dd></>}
                <dt>{p.billed_qty.toLocaleString('en-US')} billed{p.pack_rounded ? ` (packs of ${p.pack_qty})` : ''}</dt><dd className="text-right">{money(p.extended_cents)}</dd>
                {p.min_line_adjust_cents > 0 && <><dt>Minimum line charge</dt><dd className="text-right">{money(p.min_line_adjust_cents)}</dd></>}
                {p.rush && <><dt>Rush{p.rush_fee_waived ? ' (waived for this customer)' : ''}</dt><dd className="text-right">{money(p.rush_fee_cents)}</dd></>}
                <dt className="font-semibold">Line total</dt><dd className="text-right font-semibold">{money(p.line_total_cents)}</dd>
                <dt>Ships, then arrives</dt><dd className="text-right">{shortDate(p.ship_date)}, {shortDate(p.arrive_date)}</dd>
              </dl>
            ) : <p className="mt-1 text-ink-soft">Not priced yet.</p>}
            <p className="mt-2 text-xs text-ink-soft">Every number here comes from the pricing code and the ERP export. Claude never sets a price.</p>
          </section>
        </div>
      )}
    </Drawer>
  );
}

interface Event {
  id: string;
  actor: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
}

const show = (k: string, v: unknown) => (v === null || v === undefined ? 'none' : k.endsWith('_cents') && typeof v === 'number' ? money(v) : Array.isArray(v) ? v.join(', ') || 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function HistoryDrawer({ lineId, onClose }: { lineId: string; onClose: () => void }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  useEffect(() => {
    fetch(`/api/lines/${lineId}/history`).then((r) => r.json()).then((d) => setEvents(d.events));
  }, [lineId]);
  return (
    <Drawer title="History" onClose={onClose}>
      <p className="mt-1 text-sm text-ink-soft">Every change, newest first. This log can&apos;t be edited or deleted.</p>
      <ol className="mt-5 space-y-5">
        {events?.map((e) => (
          <li key={e.id} className="border-l-2 border-rule pl-4 text-sm">
            <div><span className="font-medium">{e.action.replace(/_/g, ' ')}</span> by {e.actor}</div>
            <div className="text-xs text-ink-soft">{new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' })}</div>
            {e.reason && <p className="mt-1">Reason: {e.reason}</p>}
            {e.before && e.after ? (
              <dl className="mt-2 space-y-1">
                {Object.keys(e.after).filter((k) => JSON.stringify(e.before?.[k]) !== JSON.stringify(e.after?.[k])).map((k) => (
                  <div key={k}><dt className="text-xs text-ink-soft">{k.replace(/_/g, ' ')}</dt><dd><del className="text-hold">{show(k, e.before?.[k])}</del> <ins className="no-underline">{show(k, e.after?.[k])}</ins></dd></div>
                ))}
              </dl>
            ) : e.after ? (
              <p className="mt-1 text-xs text-ink-soft">{Object.entries(e.after).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${show(k, v)}`).join('; ')}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </Drawer>
  );
}

export function TextDrawer({ title, docs, note, onClose }: { title: string; docs: { name: string; text: string }[]; note?: string; onClose: () => void }) {
  return (
    <Drawer title={title} onClose={onClose}>
      {note && <p className="mt-1 text-sm text-ink-soft">{note}</p>}
      {docs.map((d) => (
        <section key={d.name} className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="din text-lg font-semibold">{d.name}</h3>
            <div className="flex gap-2">
              <CopyButton text={d.text} />
              <button
                type="button"
                className={button.quiet}
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([d.text], { type: 'text/plain' }));
                  Object.assign(document.createElement('a'), { href: url, download: `${d.name}.txt` }).click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download
              </button>
            </div>
          </div>
          <pre className="mt-2 whitespace-pre-wrap rounded-sm border border-rule-soft bg-note px-4 py-3 font-[family-name:var(--font-ui)] text-sm leading-relaxed">{d.text}</pre>
        </section>
      ))}
    </Drawer>
  );
}
