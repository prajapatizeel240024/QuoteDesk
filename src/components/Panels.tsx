'use client';

import { useState } from 'react';
import type { Part } from '@/lib/types';
import type { LineView } from '@/server/lines/service';
import { api, button, CopyButton, HoldTag, PartLabel } from './bits';
import { asked, sourceLabel } from './LineRow';

export function NeedsPartPanel({ lines, customerId, onResolve }: { lines: LineView[]; customerId: string; onResolve: (line: LineView, choice: { part_sku: string } | { not_carried: true }) => Promise<void> }) {
  if (!lines.length) return null;
  return (
    <section aria-labelledby="needs-part" className="mt-8 border-l-4 border-warn bg-sheet px-5 py-4">
      <h2 id="needs-part" className="din text-xl font-semibold">Needs a part</h2>
      <p className="mt-1 text-sm text-ink-soft">QuoteDesk wasn&apos;t sure enough to pick a part for these, so it asked instead of guessing.</p>
      <ul className="mt-3 space-y-4">{lines.map((l) => <NeedsPartItem key={`${l.id}:${l.version}`} line={l} customerId={customerId} onResolve={onResolve} />)}</ul>
    </section>
  );
}

function NeedsPartItem({ line, customerId, onResolve }: { line: LineView; customerId: string; onResolve: (line: LineView, choice: { part_sku: string } | { not_carried: true }) => Promise<void> }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Part[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = line.match_suggestion;
  const choose = async (choice: { part_sku: string } | { not_carried: true }) => {
    setBusy(true);
    setError(null);
    try {
      await onResolve(line, choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <li className="arrive rounded-sm border border-rule px-4 py-3">
      <p className="text-sm"><a href={`#line-${line.line_no}`} className="font-medium hover:underline">Line {line.line_no}</a>: <q>{asked(line)}</q> <span className="text-xs text-ink-soft">{sourceLabel(line)}</span></p>
      {s && s.sku !== 'NONE' && <p className="mt-1 text-sm text-ink-soft">Claude suggests {s.sku}, {Math.round(s.confidence * 100)}% sure: {s.why}</p>}
      {s && s.sku === 'NONE' && <p className="mt-1 text-sm text-ink-soft">Claude found no catalog part that fits: {s.why}</p>}
      {line.match_evidence.some((e) => e.signal === 'size_conflict') && <p className="mt-1 text-sm text-ink-soft">Claude&apos;s pick didn&apos;t have the size the buyer wrote ({line.match_evidence.map((e) => e.value).join(', ')}).</p>}
      {line.candidates.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {line.candidates.map((c) => (
            <button key={c.sku} disabled={busy} onClick={() => choose({ part_sku: c.sku })} className={`flex items-center gap-2 rounded-sm border px-2 py-1.5 text-left text-sm hover:bg-note disabled:opacity-50 ${s?.sku === c.sku ? 'border-ink' : 'border-rule'}`}>
              <PartLabel sku={c.sku} />
              <span>{c.description}</span>
            </button>
          ))}
        </div>
      )}
      <form className="mt-3 flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); setError(null); try { setResults((await api<{ parts: Part[] }>(`/api/parts?q=${encodeURIComponent(q)}&customer=${customerId}`)).parts); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the catalog" className="min-w-56 grow rounded-sm border border-rule bg-sheet px-2 py-1.5 text-sm" />
        <button disabled={q.trim().length < 2} className={button.secondary}>Search</button>
        <button type="button" disabled={busy} onClick={() => choose({ not_carried: true })} className={button.quiet}>We don&apos;t carry this</button>
      </form>
      {results && (
        <ul className="mt-2 rounded-sm border border-rule-soft">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-ink-soft">Nothing in the catalog matches that.</li>}
          {results.map((r) => (
            <li key={r.sku}>
              <button disabled={busy} onClick={() => choose({ part_sku: r.sku })} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-note">
                <PartLabel sku={r.sku} /> <span>{r.description}</span> <span className="text-xs text-ink-soft">{r.stock_qty} in stock</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-hold">{error}</p>}
    </li>
  );
}

export function ExportPanel({ lines, onClear, onLeaveOut }: { lines: LineView[]; onClear: (line: LineView, reviewer: string, reason: string) => Promise<void>; onLeaveOut: (line: LineView) => Promise<void> }) {
  if (!lines.length) return null;
  return (
    <section aria-labelledby="export-hold" className="mt-8 border-l-4 border-hold bg-sheet px-5 py-4">
      <h2 id="export-hold" className="din text-xl font-semibold">Held for export review</h2>
      <p className="mt-1 text-sm text-ink-soft">These lines aren&apos;t priced and never went to Claude. A named person clears each one, or it stays out of the quote.</p>
      <ul className="mt-3 space-y-4">{lines.map((l) => <ExportItem key={`${l.id}:${l.version}`} line={l} onClear={onClear} onLeaveOut={onLeaveOut} />)}</ul>
    </section>
  );
}

function ExportItem({ line, onClear, onLeaveOut }: { line: LineView; onClear: (line: LineView, reviewer: string, reason: string) => Promise<void>; onLeaveOut: (line: LineView) => Promise<void> }) {
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flag = line.flags.find((f) => f.code === 'EXPORT_CONTROLLED');
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <li className="arrive rounded-sm border border-rule px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <HoldTag>Hold</HoldTag>
        <a href={`#line-${line.line_no}`} className="font-medium hover:underline">Line {line.line_no}</a>
        <q>{asked(line)}</q>
      </div>
      {flag && <p className="mt-1 text-sm text-ink-soft">{flag.message}</p>}
      <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => onClear(line, reviewer, reason)); }}>
        <label className="text-xs text-ink-soft">Reviewer<input value={reviewer} onChange={(e) => setReviewer(e.target.value)} className="mt-1 block w-44 rounded-sm border border-rule bg-sheet px-2 py-1.5 text-sm text-ink" /></label>
        <label className="grow text-xs text-ink-soft">What was checked<input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-sm border border-rule bg-sheet px-2 py-1.5 text-sm text-ink" /></label>
        <button disabled={busy || reviewer.trim().length < 2 || reason.trim().length < 3} className={button.secondary}>Clear the hold</button>
        <button type="button" disabled={busy} onClick={() => act(() => onLeaveOut(line))} className={button.quiet}>Leave out of the quote</button>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-hold">{error}</p>}
    </li>
  );
}

export interface Question {
  subject: string;
  body: string;
  status: string;
  drafted_by: string;
  version: number;
}

export function QuestionPanel({ question, onSave }: { question: Question; onSave: (patch: { subject?: string; body?: string; status?: 'sent' }) => Promise<void> }) {
  const [body, setBody] = useState(question.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (patch: { body?: string; status?: 'sent' }) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="question" className="mt-8 border-l-4 border-ink bg-sheet px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="question" className="din text-xl font-semibold">Question for the buyer</h2>
        <span className="text-xs text-ink-soft">{question.status === 'sent' ? 'Marked as sent' : question.drafted_by === 'template' ? 'Drafted from the template' : 'Drafted by Claude, checked for prices and missing lines'}</span>
      </div>
      <p className="mt-2 text-sm"><span className="text-ink-soft">Subject:</span> {question.subject}</p>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={Math.min(14, body.split('\n').length + 1)} className="mt-2 block w-full rounded-sm border border-rule bg-sheet px-3 py-2 text-sm leading-relaxed" />
      <div className="mt-3 flex flex-wrap gap-3">
        <CopyButton text={`Subject: ${question.subject}\n\n${body}`} label="Copy email" />
        {body !== question.body && <button disabled={busy} onClick={() => act({ body })} className={button.secondary}>Save changes</button>}
        {question.status !== 'sent' && <button disabled={busy} onClick={() => act({ status: 'sent' })} className={button.quiet}>Mark as sent</button>}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-hold">{error}</p>}
    </section>
  );
}
