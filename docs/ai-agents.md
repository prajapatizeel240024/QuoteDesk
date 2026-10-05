# AI agents: how Claude is used

QuoteDesk doesn't run open-ended agents. Claude has three narrow jobs, and each one is a single structured call with a fixed answer format. Code decides when to ask, prepares what Claude sees, checks every answer, and does all the math. This page covers each job, the client every call goes through, the export safeguards, the test stand-in, and how to change a prompt safely.

![How the AI steps work. Each of the three Claude jobs (read free text, pick a part, ask the buyer) follows the same path: code prepares the request, a safety step runs before Claude, Claude answers in a fixed JSON shape, code checks the answer, and only then is the result saved.](images/ai-pipeline.svg)

## Who does what

| Step | Done by |
| --- | --- |
| Reading spreadsheet and PDF tables | Rules |
| Reading numbered lines and bullets with a known part number | Rules |
| Reading items written as prose ("a box of 3/8 hex nuts") | **Claude** (`extract.v1`), then code parses the values |
| Screening for export terms | Rules, before Claude |
| Exact part numbers, customer part numbers, aliases | Rules |
| Ambiguous numbers, one-character typos, lines with no usable part number | **Claude** (`match.v1`), then the bar |
| Prices, lead times, rush, flags | Code only |
| Customer auto-approve rules | Rules from the YAML |
| Wording the question to the buyer | **Claude** (`question.v1`), with a template as the fallback |
| Approving lines, clearing export holds, sending anything | A person |

## Job 1: read free text (`extract.v1`)

**When it runs.** Only when a free-text line (in the email body, or in PDF text outside the table) looks like an item and no rule read it. A line looks like an item if it has a digit and an item word such as screws, bearings, valves or sensors. Table rows never trigger a call. rfq-01, a clean spreadsheet, makes no Claude call at all.

**What Claude gets** ([`src/server/llm/prompts/extract.v1.ts`](../src/server/llm/prompts/extract.v1.ts)):
- the sender and the subject
- the items the rules already found in the free text (`already_found`), so Claude doesn't repeat them
- every free-text block, with each screened clause replaced by `[item held for export review]`

**What Claude returns.** A JSON schema with every field required. It contains a list of items, each with:
- `block_ref`, the block the item came from
- `quote`, the shortest span that holds the item, copied character for character
- `part_text`, `description`, `qty_text`, `uom_text`, `due_text` and `certs_text`, each copied word for word or left empty

It also returns email-wide `defaults` (a quote, a due date text and a certs text).

The prompt's rules: copy, never convert. Skip greetings and signatures. Never guess redacted text. Never invent part numbers, quantities or dates. Never write prices.

**Checks in code** ([`src/server/extract/index.ts`](../src/server/extract/index.ts)). An item is dropped if:
- its block doesn't exist
- its quote isn't in the redacted block text
- its quote contains the redaction marker
- its quote overlaps an item the rules already found

A field that doesn't appear inside its own quote is blanked, with a note. Then code parses the values with `parseQty`, `parseUom`, `parseDue` and `parseCerts`. A quantity that won't parse is kept as the buyer's words with a note, becomes `MISSING_INFO`, and goes into the question to the buyer. A date that won't parse does the same, unless the email gives a need-by date for every line. Claude's email-wide due date is used only when the rules found none. Its email-wide certs text is ignored.

**Model and budget.** `MODEL_EXTRACT`, which defaults to `claude-sonnet-5-5`. The output budget is 1,200 tokens plus 300 per block.

**If it fails.** A refusal, a second cut-off, or an answer that zod rejects stops the run with an error. The RFQ is marked `failed`, and "Try again" runs it again.

**Where the rep sees it.** These lines are labelled "read by Claude". "Why this line" says "Claude read it from free text; every field was checked against the email."

## Job 2: pick a part (`match.v1`)

**When it runs.** After the rules. A line is sent only if all of these hold:
- it isn't held for export (marked by the buyer or caught by screening)
- the rules found no single exact match
- it has at least one candidate

There are three kinds of line ([`src/server/match/rules.ts`](../src/server/match/rules.ts)):
- **Ambiguous.** One number fits several parts. For example, "6204" could be the sealed or the shielded bearing.
- **Typo.** A part number one edit away from a catalog number: one character changed, added, dropped or swapped with its neighbour. This applies only to numbers of 6 or more characters once cleaned up.
- **Description.** The part number found nothing, or there isn't one. The candidates come from a description search (on the part text when there's no description): the top 5 active parts by weighted word overlap with the request. Rarer words count more, sizes count double, and a candidate needs a score of at least 0.4. If none scores that high, the line goes straight to "Needs a part".

**What Claude gets.** One batched call per RFQ. For each line it gets a `line_ref`, the request text (`part_text | description`) and the candidates (SKU, description and manufacturer part number). It doesn't get the customer, costs, stock or the candidate scores.

**What Claude returns.** For each line:
- `sku`: one of the batch's candidate SKUs or `NONE`. The schema enforces this with an enum.
- `confidence`
- `evidence`: quotes from the request
- `why`

zod also requires the confidence to be between 0 and 1 and allows at most 5 quotes. The prompt asks for a confidence of 0.9 or more only when size, thread, material, grade, finish and type all agree. It asks for less than 0.6 when the request leaves out a detail that separates the candidates.

**The bar** ([`decide()` in `src/server/match/index.ts`](../src/server/match/index.ts)). Claude's pick counts only if all four of these hold:
1. The SKU is one of **this line's** candidates.
2. There is at least one quote, and every quote appears in the request. Case, spacing, curly quotes and dashes are ignored.
3. The confidence is at least `MATCH_THRESHOLD`. The default is 0.80, and a confidence equal to the threshold passes.
4. No size in the request is missing from the part. Sizes include fractions and threads, M sizes, bearing series, chain sizes, o-ring dash numbers, V-belt sizes, and grades 5 and 8.

If the pick passes, the line is matched with method `claude`. If it fails, the line goes to "Needs a part" with Claude's suggestion and confidence kept for the rep. A `NONE` answer shows as "Claude found no catalog part that fits".

**Model and budget.** `MODEL_MATCH`, which defaults to `claude-haiku-4-5-20251001`. The output budget is 400 tokens plus 250 per line.

**The threshold.** When `MATCH_THRESHOLD` is unset, it's 0.8. When it's set, it has to be a number above 0 and at most 1, written like `0.80`, `.75` or `1`. An empty or out-of-range value stops with an error rather than falling back to the default. To see how other thresholds would do on stored answers, use the eval's threshold sweep ([Evals](evals.md)).

## Job 3: ask the buyer (`question.v1`)

**When it runs.** After the lines are saved, if any line is missing a quantity, a need-by date or a cert type. There is one question per RFQ.

**What Claude gets.** The buyer's first name, the RFQ subject, and for each line "Line N", the buyer's words (up to 80 characters) and what's missing ("quantity", "need-by date" or "which certificates"). It gets no part numbers from the catalog, no prices and no held lines.

**What Claude returns.** A subject and a body. zod requires the subject to be 3 to 200 characters and the body 20 to 3,000. The prompt tells Claude to:
- write as the rep
- refer to each line as "Line N" and quote the buyer's words
- ask one question for each missing detail
- make no prices and no stock or delivery promises
- write plain text, under 140 words, signed with the rep's first name

**Checks in code** ([`src/server/questions/index.ts`](../src/server/questions/index.ts)). The draft must mention every line by number, contain no price words (`$`, price, pricing, cost, USD), and be 1,500 characters or less. If it fails a check, or the call fails, QuoteDesk uses the template instead.

**Model and budget.** `MODEL_WRITE`, which defaults to `claude-sonnet-5-5`. The output budget is 900 tokens.

**Never fails the run.** The question isn't redrafted when the rep edits a line. The rep can edit it, copy it, or mark it as sent. Nothing is actually sent.

## The LLM client

Every call goes through `callStructured` in [`src/server/llm/client.ts`](../src/server/llm/client.ts):

1. **Cache lookup.** The cache key is a SHA-256 of the model, prompt version, system prompt, user payload and schema. Unless `LLM_CACHE=off`, the newest finished answer for that key is checked with zod again and reused. If it fails the check, Claude is asked again.
2. **Key check.** `ANTHROPIC_API_KEY` is needed only when the cache has no answer. Without it, the error says to add the key to `.env.local` or to set `LLM_MODE=oracle` to test without Claude.
3. **Request.** `client.messages.create` sends:
   - the model and the output budget
   - the system prompt as one block, marked for Anthropic's prompt caching
   - one user message, which is the JSON payload
   - `output_config: { format: { type: 'json_schema', schema } }`

   There are no tools and no streaming.
4. **Log.** Every API response writes one `llm_calls` row with the purpose, model, prompt version, cache key, request, parsed response, stop reason, input and output tokens, and latency. The row is written before the stop reason is handled, so refusals and cut-offs are logged too. Cache hits write nothing.
5. **Stop reasons.** A refusal raises `RefusalError`. If the answer is cut off by the output budget, the call is retried once with double the budget. A second cut-off raises `ModelOutputError`.
6. **Validation.** zod checks the answer. If it fails, `ModelOutputError` is raised and nothing is saved.
7. **Retries.** The Anthropic SDK retries connection errors and 408, 409, 429 and 5xx responses up to 3 times.

**Why zod after the JSON schema.** The API enforces the answer's shape: types, enums, required fields and no extra properties. It doesn't enforce number ranges or string lengths. Those (a confidence between 0 and 1, at most 5 quotes, the question's subject and body lengths) are checked by zod in code.

**Errors.** `jsonError` maps `ModelOutputError` and `RefusalError` to 502, and `LLMUnavailableError` (no key) to 503. The only route that calls Claude is the drafting stream, `POST /api/rfqs/{id}/run`. It answers 200 and reports these errors as `error` events. The review page shows them, with a "Try again" button when the run failed.

**Two different caches.**
- `llm_calls` is QuoteDesk's own cache. It replays identical requests, survives `npm run db:reset`, and is cleared only by `npm run db:reset -- --all`.
- The `cache_control` marker on the system prompt is Anthropic's server-side prompt caching. It only applies above a minimum prompt length (512 tokens on Sonnet 5.5, 4,096 on Haiku 4.5). QuoteDesk's system prompts are short, so it probably never applies. Check `usage.cache_read_input_tokens` before counting on it.

## Export screening and held lines

A line can be held for export review in three ways:

| Hold | Set when | Example |
| --- | --- | --- |
| `marked` | The buyer put Y, X, EC or similar in an export column of the spreadsheet. | rfq-06 |
| `screened` | The line's text contains a term from `extraction.export_screen_terms`. The list is made up: motion controller, absolute encoder, 25-bit, 25 bit. | rfq-07 |
| `catalog` | The ERP flags the matched part. Only AF-40501 and AF-40502 carry this made-up flag. | |

How held text is kept away from Claude:
- **Extraction.** Screened clauses are cut out of the free text before the call. Spreadsheet and PDF table rows never go to Claude. Any Claude quote containing the redaction marker is dropped.
- **Matching.** Marked and screened lines are not sent. If the rules can't match one exactly, its evidence reads "not sent to Claude".
- **Questions.** Held lines are left out.

A held line gets no price, and approving it returns 409. Clearing the hold needs a reviewer name and a note on what was checked. Until then, the quote email says only "We need to review this item before we can quote it, and will follow up separately."

**How it's measured.** The eval runner wraps the LLM and records every extraction block, match request and question line it sends. After each RFQ, it checks that no marked or screened line has its description or quote (strings over 6 characters) in that text. Catalog holds aren't checked. The target is 0. `tests/extract.test.ts` makes a narrower check for rfq-06 and rfq-07: no marked or screened line's description appears in the extraction blocks or match requests.

**Known gaps.** These are verified in the code and not yet fixed:
1. When Claude is called for extraction, `already_found` carries the quotes of every free-text item the rules found, including screened ones, and they're sent unredacted. The leak check doesn't record `already_found`, so it can't see this. No dev fixture triggers it today.
2. The subject and sender are sent without screening.
3. Catalog holds are decided after matching. A line whose text gets past screening can therefore be sent to Claude for matching and only then be held.
4. The leak check runs only in evals and tests, not on every live request.

The fixes are in the [production plan](production.md#gaps-to-close-first).

## The oracle stand-in

`LLM_MODE=oracle` makes `getLLM` load `oracleLLM` from [`evals/score.ts`](../evals/score.ts). It answers from the eval answer keys, so the plumbing and the screen can be tested without an API key:
- **extract** returns the key's Claude-read lines whose quote appears in a block.
- **match** returns the key's SKU at 0.95 confidence, or 0.55 when the key expects a person to review it, so that line lands in "Needs a part". It answers `NONE` when the key's SKU isn't a candidate.
- **question** returns the template.

The review page footer says when the oracle answered. Only the eval runner refuses to use the oracle on the holdout: `npm run eval -- --split holdout --llm oracle` stops with an error. The command-line loader and the web app don't check. The oracle's numbers test the machinery, and are never reported as results.

## Models and settings

| Variable | Default | Used for |
| --- | --- | --- |
| `MODEL_EXTRACT` | `claude-sonnet-5-5` | Reading free text |
| `MODEL_MATCH` | `claude-haiku-4-5-20251001` | Picking parts |
| `MODEL_WRITE` | `claude-sonnet-5-5` | Wording the question to the buyer |
| `LLM_MODE` | `anthropic` | `oracle` for tests only |
| `LLM_CACHE` | `on` | `off` always calls Claude |
| `MATCH_THRESHOLD` | `0.8` | The bar for Claude's part picks |
| `ANTHROPIC_API_KEY` | none | Needed only when the cache has no answer |

**Thinking and output budgets.** Claude Sonnet 5.5 uses adaptive thinking by default when a request doesn't set `thinking`, and thinking tokens count toward `max_tokens`. QuoteDesk sets neither thinking nor effort, and its budgets are small (900 tokens for the question). Live calls could therefore stop at `max_tokens`. Claude Haiku 4.5 doesn't think unless asked. The production plan explains how to handle this. Claude has never been called live from this code: the build sandbox had no API key.

## Changing a prompt safely

1. Copy the prompt module to a new version (for example `extract.v2.ts`), change its `VERSION`, and point the import in `src/server/llm/client.ts` at the new file. For the match prompt, also update the `MATCH_VERSION` import in `src/server/pipeline.ts`. Cache keys then change, so old answers aren't replayed.
2. Keep every schema free of price fields, and keep the checks in code.
3. Run `npm run eval -- --split dev` with Claude, and add `--no-cache` for fresh calls. Compare the report with the last one, especially wrong parts placed automatically, held text sent to Claude, and fields read right.
4. To move the bar, try `--threshold` and read the threshold sweep. Don't loosen the four checks.
5. Run the holdout once, at the end.

## Working on this repo with AI coding agents

[`CLAUDE.md`](../CLAUDE.md) holds the rules for AI coding agents, such as Claude Code, working in this repo. In short:
- Never commit, push, create branches, touch a shared or remote database, or deploy. Leave every change uncommitted in the working tree.
- Edit existing files, and ask before adding new ones.
- Make no scratch files.
- Use only the local databases.
- Use synthetic data only.
- Run one session per working tree, and have a session that wrote nothing do the final check.
- Keep the invariants listed in [Architecture](architecture.md#invariants-and-where-they-live).

Next.js 16 adds its own "agent rules" block to `CLAUDE.md` when `npm run dev` runs.
