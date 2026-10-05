import { ResolveBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { getLineViews, resolvePart } from '@/server/lines/service';
import { jsonError, repActor } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** From "Needs a part": choose a catalog part, or mark the line as not carried. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pool = getPool();
    await resolvePart(pool, id, ResolveBody.parse(await req.json()), repActor());
    const [line] = await getLineViews(pool, { ids: [id] });
    return Response.json({ line });
  } catch (err) {
    return jsonError(err);
  }
}
