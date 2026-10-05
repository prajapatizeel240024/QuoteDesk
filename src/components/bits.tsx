'use client';

import { useEffect, useState } from 'react';
import type { FlagView } from '@/server/lines/service';

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed with ${res.status}`);
  return data as T;
}

/** A catalog part number on a yellow bin label. */
export function PartLabel({ sku, muted = false }: { sku: string; muted?: boolean }) {
  return <span className={`din inline-flex items-center rounded-[3px] border px-1.5 py-px text-[0.95rem] font-semibold tracking-wide ${muted ? 'border-rule bg-note text-ink-soft line-through' : 'border-label-edge bg-label text-ink'}`}>{sku}</span>;
}

/** The red hold tag, punched like the paper tags on quarantined stock. */
export function HoldTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative inline-flex items-center rounded-r-sm bg-hold py-0.5 pl-4 pr-2 text-xs font-semibold text-white [clip-path:polygon(8px_0,100%_0,100%_100%,8px_100%,0_50%)]">
      <span aria-hidden className="absolute left-2 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-sheet" />
      {children}
    </span>
  );
}

const LABELS: Record<string, string> = {
  EXPORT_CONTROLLED: 'Export review',
  UNKNOWN_PART: 'No part',
  OBSOLETE_PART: 'Obsolete',
  SUBSTITUTED: 'Replacement',
  MISSING_INFO: 'Missing info',
  CERT_UNAVAILABLE: 'Cert not available',
  PACK_ROUNDED: 'Pack size',
  LEAD_TIME_MISS: 'Misses date',
  STOCK_SHORT: 'Short on stock',
  RUSH_FEE: 'Rush',
  MIN_LINE: 'Minimum charge',
  PRICE_OVERRIDE: 'Price set by hand',
  BELOW_FLOOR: 'Below floor margin',
};

export function flagLabel(code: string): string {
  return LABELS[code] ?? code;
}

export function FlagChip({ flag }: { flag: Pick<FlagView, 'code' | 'severity' | 'override_reason'> }) {
  if (flag.code === 'EXPORT_CONTROLLED' && flag.severity === 'block') return <HoldTag>{flagLabel(flag.code)}</HoldTag>;
  const tone = flag.override_reason ? 'border-rule bg-sheet text-ink-soft' : flag.severity === 'block' ? 'border-hold/40 bg-hold-tint text-hold' : flag.severity === 'warn' ? 'border-warn/30 bg-warn-tint text-warn' : 'border-rule bg-note text-ink-soft';
  return (
    <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {flagLabel(flag.code)}
      {flag.override_reason && <span className="ml-1 font-normal">(approved anyway)</span>}
    </span>
  );
}

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-ink/25" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} className="h-full w-full max-w-xl overflow-y-auto border-l border-rule bg-sheet px-6 py-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="din text-2xl font-semibold">{title}</h2>
          <button autoFocus onClick={onClose} className="text-sm text-ink-soft hover:underline">Close</button>
        </div>
        {children}
      </aside>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="rounded-sm border border-ink px-3 py-1.5 text-sm hover:bg-ink hover:text-sheet"
    >
      {done ? 'Copied' : label}
    </button>
  );
}

export const button = {
  primary: 'rounded-sm bg-ink px-3 py-1.5 text-sm font-medium text-sheet hover:bg-ink/90 disabled:opacity-40',
  secondary: 'rounded-sm border border-ink px-3 py-1.5 text-sm hover:bg-ink hover:text-sheet disabled:opacity-40',
  quiet: 'text-sm text-ink-soft hover:text-ink hover:underline disabled:opacity-40',
};
