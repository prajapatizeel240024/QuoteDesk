import { getPool } from '@/server/db';
import { defaultDeps, runRfq, type PipelineEvent } from '@/server/pipeline';

export const dynamic = 'force-dynamic';

const running = new Set<string>();

/** Runs the pipeline for an RFQ and streams its progress as server-sent events. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const pool = getPool();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: PipelineEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      if (running.has(id)) {
        send({ type: 'error', message: 'This RFQ is already being drafted. Wait for that run to finish.' });
        controller.close();
        return;
      }
      running.add(id);
      try {
        const deps = await defaultDeps(pool);
        await runRfq(pool, id, send, deps);
      } catch (err) {
        // runRfq reports its own errors as events. Setup errors, such as a bad MATCH_THRESHOLD, are reported here.
        if (!(err instanceof Error && /HttpError|ModelOutputError|LLMUnavailableError/.test(err.constructor.name))) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      } finally {
        running.delete(id);
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
