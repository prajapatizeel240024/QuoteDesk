// The one function that writes audit_events. Only code in src/server/lines and the ingest, quote and PO
// writers call it, always inside the same transaction as the change it records.
import type { Queryable } from '@/server/db';

export type AuditSubject = 'line' | 'rfq' | 'question' | 'quote' | 'po';

export async function audit(c: Queryable, a: { subject_type: AuditSubject; subject_id: string; version?: number | null; actor: string; action: string; before?: unknown; after?: unknown; reason?: string | null }): Promise<void> {
  await c.query(
    `insert into audit_events (subject_type, subject_id, version, actor, action, before, after, reason) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [a.subject_type, a.subject_id, a.version ?? null, a.actor, a.action, a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after), a.reason ?? null],
  );
}
