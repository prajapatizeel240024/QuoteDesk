import { RejectBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { getLineViews, rejectLine } from '@/server/lines/service';
import { jsonError, repActor } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Takes a line out of the quote, with a reason. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pool = getPool();
    await rejectLine(pool, id, RejectBody.parse(await req.json()), repActor());
    const [line] = await getLineViews(pool, { ids: [id] });
    return Response.json({ line });
  } catch (err) {
    return jsonError(err);
  }
}
