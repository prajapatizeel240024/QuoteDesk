import { getPool } from '@/server/db';
import { jsonError } from '@/server/pipeline';
import { getInbox } from '@/server/rfqs';

export const dynamic = 'force-dynamic';

/** The synthetic RFQ inbox, with whether each one has been drafted yet. */
export async function GET() {
  try {
    return Response.json({ rfqs: await getInbox(getPool()) });
  } catch (err) {
    return jsonError(err);
  }
}
