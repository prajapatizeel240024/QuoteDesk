// Every Claude call is logged to llm_calls; identical requests can be replayed from it (LLM_CACHE=on).
import crypto from 'node:crypto';
import type { Queryable } from '@/server/db';

export function cacheKey(parts: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export async function getCached(db: Queryable, key: string): Promise<unknown | null> {
  const res = await db.query<{ response: unknown }>(
    `select response from llm_calls where cache_key = $1 and response is not null and stop_reason = 'end_turn' order by id desc limit 1`,
    [key],
  );
  return res.rows[0]?.response ?? null;
}

export interface CallLog {
  purpose: 'extract' | 'match' | 'question';
  model: string;
  promptVersion: string;
  cacheKey: string;
  request: unknown;
  response: unknown;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
}

export async function logCall(db: Queryable, c: CallLog): Promise<void> {
  await db.query(
    `insert into llm_calls (purpose, model, prompt_version, cache_key, request, response, stop_reason, input_tokens, output_tokens, latency_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [c.purpose, c.model, c.promptVersion, c.cacheKey, JSON.stringify(c.request), c.response === null ? null : JSON.stringify(c.response), c.stopReason, c.inputTokens, c.outputTokens, c.latencyMs],
  );
}
