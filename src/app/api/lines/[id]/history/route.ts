import { getPool } from '@/server/db';
import { getLineHistory } from '@/server/lines/service';
import { jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json({ events: await getLineHistory(getPool(), id) });
  } catch (err) {
    return jsonError(err);
  }
}
