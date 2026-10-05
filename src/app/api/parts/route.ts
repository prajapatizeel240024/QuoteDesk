import { getPool } from '@/server/db';
import { loadParts } from '@/server/lines/service';
import { jsonError, loadCatalogIndex } from '@/server/pipeline';
import { exactLookup, retrieve } from '@/server/match/rules';

export const dynamic = 'force-dynamic';

/** Catalog search for the part picker: exact part numbers first, then descriptions. */
export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
    const customer = new URL(req.url).searchParams.get('customer');
    if (q.length < 2) return Response.json({ error: 'Type at least two characters to search the catalog.' }, { status: 400 });
    const pool = getPool();
    const idx = await loadCatalogIndex(pool);
    const parts = await loadParts(pool);
    const exact = exactLookup(q, customer, idx)?.skus ?? [];
    const skus = [...new Set([...exact, ...retrieve(q, idx, 8, 0.25).map((c) => c.sku)])].slice(0, 8);
    return Response.json({ parts: skus.map((s) => parts.get(s)!).filter(Boolean) });
  } catch (err) {
    return jsonError(err);
  }
}
