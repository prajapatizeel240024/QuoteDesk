import { QuestionPatchBody } from '@/lib/schemas';
import { getPool } from '@/server/db';
import { jsonError, repActor } from '@/server/pipeline';
import { editQuestion } from '@/server/questions/index';

export const dynamic = 'force-dynamic';

/** Edits the question for the buyer, or marks it as sent. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await editQuestion(getPool(), id, QuestionPatchBody.parse(await req.json()), repActor());
    return Response.json({ ok: true });
  } catch (err) {
    return jsonError(err);
  }
}
