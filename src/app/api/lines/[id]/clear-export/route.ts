import { ClearExportBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { getLineViews, clearExport } from '@/server/lines/service';
import { jsonError, repActor } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** A named person clears an export hold, with a reason. Only then is the line priced. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pool = getPool();
    await clearExport(pool, id, ClearExportBody.parse(await req.json()), repActor());
    const [line] = await getLineViews(pool, { ids: [id] });
    return Response.json({ line });
  } catch (err) {
    return jsonError(err);
  }
}
