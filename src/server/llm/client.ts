// The only code that calls the Claude API. Structured outputs via output_config.format, zod validation for
// what the API can't enforce, stop_reason handling, and a log row (and cache entry) per call.
// None of the three calls can return a price: the schemas have no field for one.
import Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';
import type { ZodType } from 'zod';
import { loadConfig, loadEnv } from '@/lib/config';
import { ExtractOutputZ, MatchOutputZ, QuestionOutputZ } from '@/lib/schemas';
import type { ExtractRequest, LLM, MatchItem, QuestionRequest } from '@/lib/types';
import { cacheKey, getCached, logCall, type CallLog } from './cache';
import * as extractPrompt from './prompts/extract.v1';
import * as matchPrompt from './prompts/match.v1';
import * as questionPrompt from './prompts/question.v1';

export class RefusalError extends Error {}
export class LLMUnavailableError extends Error {}
export class ModelOutputError extends Error {}

export interface StructuredCall<T> {
  purpose: CallLog['purpose'];
  model: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  zod: ZodType<T>;
  maxTokens: number;
}

let client: Anthropic | null = null;

export async function callStructured<T>(db: Pool, call: StructuredCall<T>): Promise<T> {
  loadEnv();
  const key = cacheKey({ model: call.model, prompt: call.promptVersion, system: call.system, user: call.user, schema: call.schema });
  if ((process.env.LLM_CACHE ?? 'on') !== 'off') {
    const hit = await getCached(db, key);
    if (hit !== null) {
      const ok = call.zod.safeParse(hit);
      if (ok.success) return ok.data; // a cached answer that no longer validates is ignored, and Claude is asked again
    }
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new LLMUnavailableError('ANTHROPIC_API_KEY is not set. Add it to .env.local, or set LLM_MODE=oracle to test without Claude.');
  client ??= new Anthropic({ apiKey, maxRetries: 3 });

  let maxTokens = call.maxTokens;
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const res = await client.messages.create({
      model: call.model,
      max_tokens: maxTokens,
      // The stable part goes first with a cache breakpoint, so repeated eval calls cost less.
      system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: call.user }],
      output_config: { format: { type: 'json_schema', schema: call.schema } },
    });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    await logCall(db, {
      purpose: call.purpose,
      model: call.model,
      promptVersion: call.promptVersion,
      cacheKey: key,
      request: { model: call.model, max_tokens: maxTokens, system: call.system, user: call.user },
      response: parsed,
      stopReason: res.stop_reason,
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      latencyMs: Date.now() - started,
    });
    if (res.stop_reason === 'refusal') throw new RefusalError(`Claude declined the ${call.purpose} request.`);
    if (res.stop_reason === 'max_tokens' && attempt === 0) {
      maxTokens *= 2;
      continue;
    }
    if (res.stop_reason !== 'end_turn') throw new ModelOutputError(`Claude stopped with "${res.stop_reason}" on the ${call.purpose} request.`);
    const ok = call.zod.safeParse(parsed);
    if (!ok.success) throw new ModelOutputError(`Claude's ${call.purpose} answer didn't match the expected format, so nothing was saved. Try again.`);
    return ok.data;
  }
  throw new ModelOutputError(`Claude ran out of tokens twice on the ${call.purpose} request.`);
}

export function models() {
  loadEnv();
  return { extract: process.env.MODEL_EXTRACT ?? 'claude-sonnet-5-5', match: process.env.MODEL_MATCH ?? 'claude-haiku-4-5-20251001', write: process.env.MODEL_WRITE ?? 'claude-sonnet-5-5' };
}

export function anthropicLLM(db: Pool): LLM {
  const cfg = loadConfig();
  const m = models();
  return {
    name: 'anthropic',
    async extract(req: ExtractRequest) {
      const out = await callStructured(db, { purpose: 'extract', model: m.extract, promptVersion: extractPrompt.VERSION, system: extractPrompt.system(cfg), user: extractPrompt.user(req), schema: extractPrompt.SCHEMA, zod: ExtractOutputZ, maxTokens: 1200 + 300 * req.blocks.length });
      return { ...out, meta: { promptVersion: extractPrompt.VERSION, model: m.extract } };
    },
    async match(items: MatchItem[]) {
      if (!items.length) return [];
      const out = await callStructured(db, { purpose: 'match', model: m.match, promptVersion: matchPrompt.VERSION, system: matchPrompt.system(cfg), user: matchPrompt.user(items), schema: matchPrompt.schema(items), zod: MatchOutputZ, maxTokens: 400 + 250 * items.length });
      return out.matches;
    },
    async question(req: QuestionRequest) {
      const out = await callStructured(db, { purpose: 'question', model: m.write, promptVersion: questionPrompt.VERSION, system: questionPrompt.system(cfg), user: questionPrompt.user(req), schema: questionPrompt.SCHEMA, zod: QuestionOutputZ, maxTokens: 900 });
      return { ...out, meta: { promptVersion: questionPrompt.VERSION, model: m.write } };
    },
  };
}

/** LLM_MODE=anthropic (default) calls Claude. LLM_MODE=oracle answers from the eval keys, for testing only. */
export async function getLLM(db: Pool): Promise<LLM> {
  loadEnv();
  const mode = process.env.LLM_MODE ?? 'anthropic';
  if (mode === 'oracle') {
    const { oracleLLM } = await import('../../../evals/score');
    return oracleLLM();
  }
  if (mode !== 'anthropic') throw new Error(`LLM_MODE must be "anthropic" or "oracle", not "${mode}"`);
  return anthropicLLM(db);
}
