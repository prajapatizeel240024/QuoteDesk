import { ReopenBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { getLineViews, reopenLine } from '@/server/lines/service';
import { jsonError, repActor } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Back to draft. Reasons given for blocking flags stay until the line is edited. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pool = getPool();
    await reopenLine(pool, id, ReopenBody.parse(await req.json()), repActor());
    const [line] = await getLineViews(pool, { ids: [id] });
    return Response.json({ line });
  } catch (err) {
    return jsonError(err);
  }
}
