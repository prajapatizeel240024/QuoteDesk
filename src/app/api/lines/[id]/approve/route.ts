import { ApproveBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { getLineViews, approveLine } from '@/server/lines/service';
import { jsonError, repActor } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Approves a line. Blocking flags need a reason; export holds must be cleared first. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pool = getPool();
    await approveLine(pool, id, ApproveBody.parse(await req.json()), repActor());
    const [line] = await getLineViews(pool, { ids: [id] });
    return Response.json({ line });
  } catch (err) {
    return jsonError(err);
  }
}
