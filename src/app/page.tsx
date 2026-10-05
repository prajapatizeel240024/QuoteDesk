'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, button } from '@/components/bits';
import { money } from '@/lib/format';

interface InboxRow {
  fixture_id: string;
  received_at: string;
  from: { name: string; email: string };
  company: string | null;
  subject: string;
  attachments: string[];
  rfq_id: string | null;
  status: string | null;
  lines: number;
  needs_you: number;
  total_cents: number;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

function statusText(r: InboxRow): string {
  if (!r.status) return 'Not drafted';
  if (r.status === 'quoted') return `Quoted, ${money(r.total_cents)}`;
  if (r.status === 'drafted') return r.needs_you ? `${r.needs_you} of ${r.lines} lines need you` : `${r.lines} lines ready`;
  if (r.status === 'failed') return 'Draft failed';
  return 'Loaded';
}

export default function Inbox() {
  const router = useRouter();
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ rfqs: InboxRow[] }>('/api/fixtures')
      .then((d) => setRows(d.rfqs))
      .catch((e: Error) => setError(e.message));
  }, []);

  async function open(r: InboxRow) {
    if (r.rfq_id) return router.push(`/rfqs/${r.rfq_id}`);
    setBusy(r.fixture_id);
    try {
      const d = await api<{ rfq_id: string }>('/api/rfqs', 'POST', { fixture_id: r.fixture_id });
      router.push(`/rfqs/${d.rfq_id}`);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-4 border-ink pb-3">
        <h1 className="din text-5xl font-bold tracking-tight">QuoteDesk</h1>
        <p className="max-w-md text-sm text-ink-soft">RFQs in, quotes out. Pick a request and QuoteDesk reads the email and its attachments, matches each line to the catalog and prices it for you to check.</p>
      </header>
      {error && <p role="alert" className="mt-6 rounded-sm border border-hold/40 bg-hold-tint px-4 py-3 text-hold">{error}</p>}
      <section aria-label="Quote requests" className="mt-6 border border-rule bg-sheet">
        {rows === null && !error && <p className="px-5 py-6 text-ink-soft">Loading the inbox…</p>}
        <ul>
          {rows?.map((r) => (
            <li key={r.fixture_id} className="grid gap-x-6 gap-y-1 border-b border-rule-soft px-5 py-4 last:border-b-0 sm:grid-cols-[9rem_1fr_auto] sm:items-center">
              <span className="text-sm text-ink-soft figures">{when(r.received_at)}</span>
              <div className="min-w-0">
                <div className="truncate font-medium">{r.subject}</div>
                <div className="truncate text-sm text-ink-soft">
                  {r.from.name}
                  {r.company ? `, ${r.company}` : ` (${r.from.email})`}
                  {r.attachments.length > 0 && <span className="ml-3">{r.attachments.join(', ')}</span>}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <span className={`text-sm ${r.status === 'quoted' ? 'text-ok' : r.needs_you ? 'text-warn' : 'text-ink-soft'}`}>{statusText(r)}</span>
                <button onClick={() => open(r)} disabled={busy !== null} className={r.rfq_id ? button.secondary : button.primary}>
                  {busy === r.fixture_id ? 'Loading…' : r.rfq_id ? 'Open' : 'Draft quote'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <p className="mt-6 text-sm text-ink-soft">Synthetic data only. Every company, part number, .example address and 555-01xx number is made up.</p>
    </main>
  );
}
