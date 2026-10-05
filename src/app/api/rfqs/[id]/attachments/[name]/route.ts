import fs from 'node:fs';
import path from 'node:path';
import { getPool } from '@/server/db';
import { fixtureDir } from '@/server/ingest/fixture';
import { jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = { '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pdf': 'application/pdf' };

/** The original attachment, so the rep can check a line against what the buyer sent. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  try {
    const { id, name } = await params;
    const filename = decodeURIComponent(name);
    const doc = await getPool().query<{ fixture_id: string }>(`select r.fixture_id from rfq_documents d join rfqs r on r.id = d.rfq_id where d.rfq_id = $1 and d.filename = $2 and d.kind <> 'body'`, [id, filename]);
    if (!doc.rowCount) return Response.json({ error: 'That attachment is not part of this RFQ.' }, { status: 404 });
    const file = fs.readFileSync(path.join(fixtureDir(doc.rows[0].fixture_id), path.basename(filename)));
    return new Response(new Uint8Array(file), { headers: { 'Content-Type': TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream', 'Content-Disposition': `inline; filename="${path.basename(filename)}"` } });
  } catch (err) {
    return jsonError(err);
  }
}
