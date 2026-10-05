import { getPool } from '@/server/db';
import { jsonError } from '@/server/pipeline';
import { getRfqView } from '@/server/rfqs';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json(await getRfqView(getPool(), id));
  } catch (err) {
    return jsonError(err);
  }
}
