'use client';

import { useMemo, useState } from 'react';
import { money, pct, shortDate } from '@/lib/format';
import { CERTS, type Cert, type Part, type PricingRules, type Tier, type Uom } from '@/lib/types';
import { evaluateLine } from '@/server/lines/evaluate';
import type { LineView } from '@/server/lines/service';
import { api, button, FlagChip, HoldTag, PartLabel } from './bits';

export interface PricingCtx {
  rules: PricingRules;
  holidays: string[];
  quote_date: string;
  tier: Tier;
  rush_fee_waived: boolean;
}

export interface RowActions {
  approve: (overrideReason?: string) => Promise<void>;
  reject: (reason: string) => Promise<void>;
  reopen: () => Promise<void>;
  save: (patch: Record<string, unknown>) => Promise<void>;
  showSources: () => void;
  showHistory: () => void;
}

export function sourceLabel(l: Pick<LineView, 'source' | 'extraction_method'>): string {
  const s = l.source;
  const where = s.kind === 'xlsx' ? `${s.doc}, row ${s.row}` : s.kind === 'pdf' ? `${s.doc}${s.index !== undefined ? `, table row ${s.index + 1}` : ''}` : 'Email body';
  return l.extraction_method === 'claude' ? `${where}, read by Claude` : where;
}

export function asked(l: Pick<LineView, 'requested'>): string {
  return [l.requested.part_text, l.requested.description].filter(Boolean).join(', ') || '(left blank)';
}

export function LineRow({ line, pricing, customerId, actions }: { line: LineView; pricing: PricingCtx; customerId: string; actions: RowActions }) {
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [asking, setAsking] = useState<null | 'override' | 'reject'>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocking = line.flags.filter((f) => f.severity === 'block' && !f.override_reason);
  const draft = line.status === 'draft';
  const held = Boolean(line.export_hold && !line.export_cleared);
  const p = line.price;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setAsking(null);
      setReason('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li id={`line-${line.line_no}`} className={`arrive grid grid-cols-[3rem_1fr] border-b border-rule-soft last:border-b-0 sm:grid-cols-[3.5rem_1fr_12rem] ${line.status === 'approved' ? 'bg-ok-tint/50' : line.status === 'rejected' ? 'bg-note/70' : ''}`}>
      <div className="din border-r border-rule px-3 py-4 text-right text-xl font-semibold text-ink-soft">{line.line_no}</div>
      <div className="min-w-0 px-4 py-4">
        <p className="text-sm">
          <span className="text-ink-soft">Asked for </span>
          <q className="font-medium">{asked(line)}</q>
          <span className="ml-2 text-xs text-ink-soft">{sourceLabel(line)}</span>
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {line.part ? (
            <>
              <PartLabel sku={line.part.sku} muted={line.status === 'rejected'} />
              <span className={line.status === 'rejected' ? 'text-ink-soft line-through' : ''}>{line.part.description}</span>
            </>
          ) : held ? (
            <HoldTag>Held for export review</HoldTag>
          ) : (
            <span className="text-sm font-medium text-hold">{line.not_carried ? 'Not a catalog item' : 'No part yet'}</span>
          )}
        </div>
        {line.part && (
          <p className="mt-1 text-xs text-ink-soft">
            {line.part.supplier_name} {line.part.mfr_part}. {line.part.stock_qty.toLocaleString('en-US')} in stock, then {line.part.lead_time_days} business days.
            {line.part.pack_qty > 1 ? ` Packs of ${line.part.pack_qty}.` : ''}
            {line.requested_part ? ` Replaces ${line.requested_part.sku}, which is obsolete.` : ''}
            {line.match_method === 'claude' && line.match_confidence !== null ? ` Matched by Claude at ${Math.round(line.match_confidence * 100)}%.` : ''}
          </p>
        )}
        <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
          <span>{line.qty === null ? <span className="text-hold">No quantity</span> : `${line.qty.toLocaleString('en-US')} ${line.uom}`}</span>
          <span>{line.due_date ? `Need by ${shortDate(line.due_date)}` : <span className="text-warn">No need-by date</span>}</span>
          {line.certs.length > 0 && <span>Certs: {line.certs.join(', ')}</span>}
          {line.certs_unclear && <span className="text-hold">Which certs?</span>}
        </p>
        {line.flags.length > 0 && (
          <ul className="mt-2 space-y-1">
            {line.flags.map((f, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <FlagChip flag={f} />
                <span className="text-ink-soft">{f.override_reason ? `Approved anyway: ${f.override_reason}` : f.message}</span>
                {draft && f.code === 'OBSOLETE_PART' && line.replacement && (
                  <button disabled={busy} onClick={() => run(() => actions.save({ part_sku: line.replacement!.sku }))} className="text-sm font-medium underline underline-offset-2">
                    Use {line.replacement.sku}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {line.status === 'approved' && <p className="mt-2 text-sm font-medium text-ok">{line.approved_by?.startsWith('rule:') ? `Approved by the customer rule "${line.approved_by.split('/').slice(1).join('/')}"` : 'Approved'}</p>}
        {line.status === 'rejected' && <p className="mt-2 text-sm text-ink-soft">Not quoted: {line.status_reason}</p>}
        {mode === 'edit' && <LineEditor line={line} pricing={pricing} customerId={customerId} onCancel={() => setMode('view')} onSave={async (patch) => { await actions.save(patch); setMode('view'); }} />}
        {mode === 'view' && (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {draft && !held && p && <button disabled={busy} onClick={() => (blocking.length ? setAsking('override') : run(() => actions.approve()))} className={button.primary}>Approve</button>}
            {draft && !held && <button onClick={() => setMode('edit')} className="text-sm hover:underline">Edit</button>}
            {draft && <button onClick={() => setAsking('reject')} className="text-sm hover:underline">Leave out</button>}
            {!draft && <button disabled={busy} onClick={() => run(actions.reopen)} className="text-sm hover:underline">Reopen</button>}
            <button onClick={actions.showSources} className={button.quiet}>Why this line</button>
            <button onClick={actions.showHistory} className={button.quiet}>History</button>
          </div>
        )}
        {asking && (
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => (asking === 'reject' ? actions.reject(reason) : actions.approve(reason))); }}>
            <label className="grow text-sm">
              {asking === 'reject' ? 'Why leave this line out of the quote? (internal only)' : `This line has ${blocking.length === 1 ? 'a blocking flag' : 'blocking flags'}. Why approve it anyway?`}
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-sm border border-rule bg-sheet px-2 py-1.5" />
            </label>
            <button disabled={busy || reason.trim().length < 3} className={button.secondary}>{asking === 'reject' ? 'Leave out' : 'Approve anyway'}</button>
            <button type="button" onClick={() => setAsking(null)} className={button.quiet}>Cancel</button>
          </form>
        )}
        {error && <p role="alert" className="mt-2 text-sm text-hold">{error}</p>}
      </div>
      <div className="col-span-2 border-t border-rule-soft px-4 py-3 text-right sm:col-span-1 sm:border-l sm:border-t-0 sm:py-4">
        {p ? (
          <>
            <div className="figures text-xs text-ink-soft">{p.billed_qty.toLocaleString('en-US')} x {money(p.unit_cents)}{p.overridden ? ', set by hand' : ''}</div>
            <div className={`din figures text-2xl font-semibold ${line.status === 'rejected' ? 'text-ink-soft line-through' : ''}`}>{money(p.line_total_cents)}</div>
            {p.rush_fee_cents > 0 && <div className="figures text-xs text-ink-soft">includes rush {money(p.rush_fee_cents)}</div>}
            {p.min_line_adjust_cents > 0 && <div className="figures text-xs text-ink-soft">includes minimum {money(p.min_line_adjust_cents)}</div>}
            <div className={`mt-1 text-xs ${p.misses_due ? 'font-medium text-warn' : 'text-ink-soft'}`}>Arrives {shortDate(p.arrive_date)}</div>
            <div className="text-xs text-ink-soft">Margin {pct(p.actual_margin_bps)}</div>
          </>
        ) : (
          <div className="text-sm text-ink-soft">{held ? 'No price while held' : 'Not priced'}</div>
        )}
      </div>
    </li>
  );
}

function LineEditor({ line, pricing, customerId, onSave, onCancel }: { line: LineView; pricing: PricingCtx; customerId: string; onSave: (patch: Record<string, unknown>) => Promise<void>; onCancel: () => void }) {
  const [part, setPart] = useState<Part | null>(line.part);
  const [qty, setQty] = useState(line.qty?.toString() ?? '');
  const [uom, setUom] = useState<Uom>(line.uom);
  const [due, setDue] = useState(line.due_date ?? '');
  const [certs, setCerts] = useState<Cert[]>(line.certs);
  const [certsTouched, setCertsTouched] = useState(false);
  const [override, setOverride] = useState(line.price_override_cents ? (line.price_override_cents / 100).toFixed(2) : '');
  const [reason, setReason] = useState(line.price_override_reason ?? '');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Part[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qtyNum = /^\d+$/.test(qty.trim()) && Number(qty) > 0 ? Number(qty) : null;
  const overrideCents = /^\d+(\.\d{1,2})?$/.test(override.trim()) ? Math.round(Number(override) * 100) : null;

  // The same pricing and checks the server runs, as the rep types. The server prices again on save.
  const preview = useMemo(() => {
    const parts = new Map<string, Part>(part ? [[part.sku, part]] : []);
    try {
      return evaluateLine(
        { requested: line.requested, qty: qtyNum, uom, due_date: due || null, certs, certs_unclear: line.certs_unclear && !certsTouched, part_sku: part?.sku ?? null, requested_sku: null, match_status: part && line.match_status === 'needs_review' ? 'resolved' : line.match_status, claude_said_none: line.claude_said_none, export_hold: line.export_hold, export_term: line.export_term, export_cleared: line.export_cleared, price_override_cents: overrideCents || null, price_override_reason: reason || null },
        { parts, tier: pricing.tier, rules: pricing.rules, customerRules: { default_certs: [], rush_fee_waived: pricing.rush_fee_waived, substitutes: 'ask', auto_approve: [] }, holidays: pricing.holidays, quote_date: pricing.quote_date },
      );
    } catch {
      return null;
    }
  }, [line, part, qtyNum, uom, due, certs, certsTouched, overrideCents, reason, pricing]);

  async function search() {
    setError(null);
    try {
      setResults((await api<{ parts: Part[] }>(`/api/parts?q=${encodeURIComponent(q)}&customer=${customerId}`)).parts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    const patch: Record<string, unknown> = {};
    if (part && part.sku !== line.part_sku) patch.part_sku = part.sku;
    if (qtyNum !== null && qtyNum !== line.qty) patch.qty = qtyNum;
    if (uom !== line.uom) patch.uom = uom;
    if ((due || null) !== line.due_date) patch.due_date = due || null;
    if (certsTouched) patch.certs = certs;
    const oldOverride = line.price_override_cents ?? null;
    if ((overrideCents || null) !== oldOverride) {
      patch.price_override_cents = overrideCents || null;
      if (overrideCents) patch.price_override_reason = reason.trim();
    } else if (overrideCents && reason.trim() !== (line.price_override_reason ?? '')) patch.price_override_reason = reason.trim();
    if (!Object.keys(patch).length) return onCancel();
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const field = 'mt-1 block rounded-sm border border-rule bg-sheet px-2 py-1.5 text-sm text-ink';
  return (
    <div className="mt-3 rounded-sm border border-rule bg-desk/40 p-4">
      <div className="text-xs text-ink-soft">Part</div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {part ? <><PartLabel sku={part.sku} /><span className="text-sm">{part.description}</span></> : <span className="text-sm text-hold">No part chosen</span>}
      </div>
      <form className="mt-2 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalog: part number or words" className="min-w-64 grow rounded-sm border border-rule bg-sheet px-2 py-1.5 text-sm" />
        <button disabled={q.trim().length < 2} className={button.secondary}>Search</button>
      </form>
      {results && (
        <ul className="mt-2 max-h-56 overflow-y-auto rounded-sm border border-rule-soft bg-sheet">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-ink-soft">Nothing in the catalog matches that.</li>}
          {results.map((r) => (
            <li key={r.sku}>
              <button type="button" onClick={() => { setPart(r); setResults(null); }} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-note">
                <PartLabel sku={r.sku} />
                <span>{r.description}</span>
                <span className="text-xs text-ink-soft">{r.stock_qty} in stock{r.status === 'obsolete' ? ', obsolete' : ''}{r.export_controlled ? ', export-controlled' : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-xs text-ink-soft">Quantity<input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className={`${field} w-28`} /></label>
        <label className="text-xs text-ink-soft">Unit<select value={uom} onChange={(e) => setUom(e.target.value as Uom)} className={field}><option value="EA">EA (each)</option><option value="FT">FT (feet)</option><option value="PK">PK (packs)</option></select></label>
        <label className="text-xs text-ink-soft">Need by<input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={field} /></label>
        <fieldset className="text-xs text-ink-soft">
          <legend>Certs</legend>
          <div className="mt-1 flex flex-wrap gap-3 text-sm text-ink">
            {CERTS.map((c) => (
              <label key={c} className="flex items-center gap-1">
                <input type="checkbox" checked={certs.includes(c)} onChange={(e) => { setCertsTouched(true); setCerts(e.target.checked ? [...certs, c] : certs.filter((x) => x !== c)); }} />
                {c}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="text-xs text-ink-soft">Unit price by hand ($)<input inputMode="decimal" value={override} onChange={(e) => setOverride(e.target.value)} placeholder={line.price ? (line.price.list_unit_cents / 100).toFixed(2) : ''} className={`${field} w-32`} /></label>
        {override.trim() && <label className="grow text-xs text-ink-soft">Why (goes in the history)<input value={reason} onChange={(e) => setReason(e.target.value)} className={`${field} w-full`} /></label>}
      </div>
      <div className="mt-4 rounded-sm border border-rule-soft bg-sheet px-3 py-2 text-sm" aria-live="polite">
        {preview?.price ? (
          <span className="figures">New total <strong>{money(preview.price.line_total_cents)}</strong> ({preview.price.billed_qty.toLocaleString('en-US')} x {money(preview.price.unit_cents)}), margin {pct(preview.price.actual_margin_bps)}, arrives {shortDate(preview.price.arrive_date)}.</span>
        ) : (
          <span className="text-ink-soft">No price yet: it needs an active part and a quantity.</span>
        )}
        {preview && preview.flags.filter((f) => f.severity !== 'info').length > 0 && (
          <ul className="mt-1 space-y-1">{preview.flags.filter((f) => f.severity !== 'info').map((f, i) => <li key={i} className="flex flex-wrap items-center gap-2"><FlagChip flag={{ ...f, override_reason: null }} /><span className="text-ink-soft">{f.message}</span></li>)}</ul>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-hold">{error}</p>}
      <div className="mt-4 flex gap-3">
        <button type="button" onClick={save} disabled={saving || (override.trim() !== '' && (!overrideCents || reason.trim().length < 3))} className={button.primary}>{saving ? 'Saving…' : 'Save changes'}</button>
        <button type="button" onClick={onCancel} className={button.quiet}>Cancel</button>
      </div>
    </div>
  );
}
