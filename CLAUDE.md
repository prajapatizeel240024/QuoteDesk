# QuoteDesk: rules for Claude Code

Read README.md first. It and config/quotedesk.yaml are the source of truth for names, layout and rules.

## Hard rules
- Never commit, push, create branches, touch a shared or remote database, or deploy. Leave every change uncommitted in the working tree.
- Edit existing files. If a new file seems necessary, stop and ask first. Generated files (lockfile, next-env.d.ts, node_modules, .next, evals/reports) are fine.
- No probe or scratch files. Check things with stdout-only commands (node -e, npx tsx -e, psql -c). If a temp file is truly unavoidable, ask first and delete it before you finish.
- Databases: local Postgres only (quote_desk_dev, quote_desk_eval). src/server/db.ts refuses any other host.
- Synthetic data only: .example domains, 555-01xx numbers, made-up part numbers, no real export classifications or defense data.
- One Claude Code session per working tree at a time. A final verify comes from a session that wrote nothing in the tree.

## Invariants
- Claude never sets a price. Prices come only from src/server/pricing/engine.ts, in integer cents.
- Only src/server/lines/ writes quote_lines and line_flags. Every change writes exactly one audit row in the same transaction. audit_events is append-only (database trigger).
- Every Claude call goes through src/server/llm/client.ts: structured outputs, zod validation, llm_calls logging, response cache.
- A Claude part match counts only if it is a listed candidate, clears MATCH_THRESHOLD, quotes the request word for word, and has no size conflict. Otherwise the line goes to "Needs a part".
- Export screening runs before any text goes to Claude. Held lines get no price, never reach Claude, and need a named person to clear them.
- MATCH_THRESHOLD must parse to a number above 0 and at most 1.
- LLM_MODE=oracle is for tests only, refuses the holdout, and its numbers are never reported as results.
- Customer rules in YAML use a fixed vocabulary; unknown keys are an error.

## Commands
npm run db:up | db:migrate | db:seed | db:reset
npm run rfq:load -- rfq-03 [--llm oracle]
npm run dev | typecheck | test | build
npm run eval -- --split dev [--llm oracle] [--no-cache]

## Done means
Typecheck clean, tests green, the session's checks pass, and a closing summary that lists every file created or changed.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
