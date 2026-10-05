import { getPool } from '@/server/db';
import { generateQuote } from '@/server/export/quote-email';
import { jsonError, repActor } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

/** Builds the quote email from the approved lines. Every line must be approved or rejected first. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return Response.json(await generateQuote(getPool(), id, repActor()), { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
