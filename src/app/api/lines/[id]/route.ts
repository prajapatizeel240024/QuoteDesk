import { PatchLineBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { editLine, getLineViews } from '@/server/lines/service';
import { jsonError, repActor } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Edits a draft line: part, quantity, unit, date, certs, or a hand-set unit price with a reason. The price is recomputed by code. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pool = getPool();
    await editLine(pool, id, PatchLineBody.parse(await req.json()), repActor());
    const [line] = await getLineViews(pool, { ids: [id] });
    return Response.json({ line });
  } catch (err) {
    return jsonError(err);
  }
}
