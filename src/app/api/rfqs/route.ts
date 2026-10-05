import { LoadRfqBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { ingestFixture } from '@/server/ingest/fixture';
import { jsonError } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Loads a synthetic RFQ: the email and its parsed attachments. Loading it twice returns the existing one. */
export async function POST(req: Request) {
  try {
    const { fixture_id } = LoadRfqBody.parse(await req.json());
    const { rfqId, created } = await ingestFixture(getPool(), fixture_id);
    return Response.json({ rfq_id: rfqId, created }, { status: created ? 201 : 200 });
  } catch (err) {
    return jsonError(err);
  }
}
