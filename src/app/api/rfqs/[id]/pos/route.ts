import { getPool } from '@/server/db';
import { draftPurchaseOrders } from '@/server/export/purchase-orders';
import { jsonError, repActor } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Drafts supplier purchase orders for approved lines that stock doesn't cover. Nothing is sent. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json({ pos: await draftPurchaseOrders(getPool(), id, repActor()) }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
