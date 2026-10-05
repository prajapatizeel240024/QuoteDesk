# Production plan

> **Plan only.** None of this is built or deployed. QuoteDesk runs on localhost, and nothing in this repository deploys anything: there are no CI workflows, hosting configs or container images for the app. The only container file is `docker-compose.yml`, which runs a local Postgres on 127.0.0.1.

This page describes how the same pipeline would run for a real distributor: what changes, the gaps in today's code to fix first, how Claude would be operated, and a rollout path. Nothing here changes the core rules:
- Claude never sets a price.
- Only the lines service writes lines, with one audit row per change.
- Export screening runs before Claude.
- A person makes the call.

![Production design, plan only. Inside the distributor's private network: intake, object storage, a job queue, pipeline workers, OCR, an LLM gateway, managed Postgres, the web app, an ERP sync, a secrets manager, observability and a CI eval gate. Outside it: the quote mailbox, the ERP, the Claude API, email sending, single sign-on, and the reps and compliance reviewers.](images/production-architecture.svg)

## What changes

| Area | Today | In production |
| --- | --- | --- |
| Intake | Fixture folders under `evals/rfqs/`, loaded by id | A mail connector on the quotes mailbox (IMAP, Microsoft Graph or the Gmail API) plus an upload screen, producing the same message shape. Replies, forwards and HTML bodies are handled. |
| Attachments | .xlsx, and PDFs that have a text layer. Any other type fails the RFQ. Original files aren't kept. | More file types (.xls, .csv, .docx, images), OCR for scanned PDFs, and a flag on the one file that fails instead of a failed RFQ. Originals kept in encrypted object storage. |
| Running a draft | Inside the HTTP request, in one Node process, with an in-memory lock | A job queue and workers. The RFQ is claimed in the database with one `update ... where status in (...)`, and progress is read from saved state. |
| Catalog, stock, costs | A CSV export, copied in by `db:seed` | An ERP sync on a schedule, plus a live stock check when drafting. Drafts are re-priced, or flagged as stale, when cost or stock changes. |
| Part search | An in-memory index rebuilt for every RFQ. Fine for 73 parts. | A real search index (Postgres trigram or full-text search, or a search engine), with capped candidate lists |
| Users | No logins. Every rep action is recorded as `rep:MO`. Loading an RFQ and pipeline writes are recorded as `system`, and customer-rule approvals as `rule:<customer>/<rule>`. | Single sign-on and an actor per person in the audit log. Roles: rep, compliance reviewer (the only role that can clear export holds) and admin. |
| Database | Local Postgres. `assertLocal()` allows only localhost. | Managed Postgres on a private network, with TLS, backups and point-in-time restore, a least-privilege app role, and an allowlist per environment instead of localhost only |
| Audit log | A trigger blocks `UPDATE` and `DELETE`. `db:reset` truncates the table. | Also block `TRUNCATE`, revoke changes from the app role, and copy rows to write-once storage. No reset in production. |
| Claude | `client.ts`, with the key in `.env.local`. Never run live. | The same contract behind a gateway: a secrets manager, a held-text guard, explicit thinking and token budgets, refusal handling, spend limits and metrics. See [Claude in production](#claude-in-production). |
| Outputs | Text for the rep to copy. Nothing is sent. | Approved quotes and questions sent through the mail system after a person approves them. A PDF quote. POs created as drafts in the ERP. Generating twice doesn't create a second number. |
| Config | One YAML file, loaded once per process | Versioned config with review, validated at startup, and the pricing-rule version stored with each price |
| Evals | 15 synthetic RFQs, run by hand | A larger anonymized set of real RFQs, a private frozen holdout, and an eval gate in CI |
| Network | 127.0.0.1 only | A private network. The web app sits behind single sign-on. Only Claude, the mail system and the ERP are reachable outbound. |

## Gaps to close first

All of these were found and confirmed by reading today's code. None is fixed yet.

### Safety

| # | Gap | Where | Fix |
| --- | --- | --- | --- |
| 1 | When Claude is called for extraction, `already_found` lists the quotes of every free-text item the rules found, including screened ones, and sends them unredacted. | `src/server/extract/index.ts` (`ruleQuotes`), `src/server/llm/prompts/extract.v1.ts` | Leave screened quotes out of `already_found`. Screen the subject and sender too. Match terms on normalized text and across line breaks. |
| 2 | Catalog holds are decided after matching, so a line whose text gets past screening can reach Claude's matcher before it is held. | `src/server/pipeline.ts`, `src/server/match/index.ts` | Hold, or leave out of the request, any line whose candidates include an export-flagged part before calling Claude. |
| 3 | A cleared catalog hold carries over when the rep swaps to a different export-flagged part. | `editLine` in `src/server/lines/service.ts` | Reset `export_cleared` whenever the part changes. |
| 4 | The local-only database check reads only the URL's host name, but `pg` also honours a `?host=` parameter, so a URL can point elsewhere and still pass. | `assertLocal()` in `src/server/db.ts` | Check the host `pg` will actually use (parse it with `pg-connection-string`), refuse `host` and `hostaddr` parameters, and add a test. |
| 5 | Only the eval runner refuses the oracle on the holdout. The web app and the command-line loader allow `LLM_MODE=oracle` on any RFQ. | `getLLM()` in `src/server/llm/client.ts`, `evals/run.ts` | Allow the oracle only in tests and evals, and refuse the holdout inside `oracleLLM` itself. |
| 6 | The held-text check runs only in evals and tests. | `recording()` in `evals/run.ts` | Check every outgoing payload in `callStructured` for screening terms and held-line text, refuse to send if either appears, and log it. |
| 7 | There's no login. Anyone who can reach the app can approve lines, set prices or clear export holds, and the reviewer name is free text. | `repActor()` in `src/server/pipeline.ts`, `clearExport` | Add single sign-on and roles. The reviewer is the signed-in compliance user. |

### Correctness

| # | Gap | Where | Fix |
| --- | --- | --- | --- |
| 8 | Auto-approval doesn't check blocking flags itself. It relies on each YAML rule setting `no_flags`. | `autoApprove` in `src/server/lines/service.ts` | Refuse lines with unresolved blocking flags inside `autoApprove`. |
| 9 | Generating a quote or POs reads the lines outside the transaction, so a concurrent edit or reopen can slip in. | `generateQuote`, `draftPurchaseOrders` in `src/server/export/` | Lock or version-check the lines inside the transaction. |
| 10 | Prices are fixed at the last edit. Approval and quoting trust the stored price. | `approveLine`, `generateQuote` | Re-evaluate at approval and quote time, or store the catalog snapshot each price used. |
| 11 | Each click on "Generate quote email" or "Draft supplier POs" creates new numbers. | `src/server/export/` | Make generation idempotent, and mark earlier quotes as superseded. |
| 12 | The question to the buyer isn't redrafted after the rep edits a line. | `draftQuestion` runs only in the pipeline | Redraft, or flag the question as stale, when lines change. |
| 13 | Error handling has several holes. Anthropic SDK errors (rate limit, auth, overload) become generic 500s or stream errors. A refusal is reported twice on the stream. An unknown RFQ id on the run route emits nothing. Malformed JSON and non-UUID ids return 500. | `jsonError` in `src/server/pipeline.ts`, `src/app/api/rfqs/[id]/run/route.ts` | Catch the SDK's typed errors, use `instanceof` instead of class-name strings, return 400 for bad JSON, and check ids. |
| 14 | Table rows and email-body lines aren't de-duplicated against each other. Items Claude proposed that the checks rejected aren't saved anywhere. | `src/server/extract/index.ts` | De-duplicate by part, quantity and quote, and save rejected items so the rep can see them. |

### Hardening

- Add `.env*.local`, `.DS_Store` and logs to `.gitignore`.
- Block `TRUNCATE` on `audit_events`.
- Check auto-approve `categories` against the catalog's categories.
- Move hard-coded extraction heuristics (item words, unit words, header fallbacks) into the config.
- Use the distributor's time zone from the config in the UI.

## Claude in production

- **Run it live first.** Real Claude calls have never been made from this code. Start with `npm run rfq:load -- rfq-03`, which exercises all three prompts: Claude reads a line that's only in the email body, matches the ambiguous "6204", and words the question about the "TBD" quantity. Then try `rfq-04`, which is prose only, and run the dev eval with Claude. Read tokens and latency from `llm_calls`, and work out cost from the tokens. The table has no RFQ id, so load one RFQ at a time to get numbers per RFQ.
- **Thinking and output budgets.** Claude Sonnet 5.5, the default for extraction and questions, uses adaptive thinking when a request doesn't set `thinking`, and thinking counts toward `max_tokens`. QuoteDesk sets neither thinking nor effort, and its budgets are small: 900 tokens for the question, 1,200 plus 300 per block for extraction. Either set effort explicitly (`low` suits these short, structured calls) or turn thinking off for these routes. On Sonnet 5.5 that means `thinking: {type: "between_tools"}`, because `disabled` is rejected there. Give `max_tokens` real headroom, and watch `stop_reason` in `llm_calls`. Claude Haiku 4.5, the matcher, doesn't think unless asked.
- **Refusals.** Sonnet 5.5 can decline a request with `stop_reason: "refusal"` and a `stop_details` category. Today a refusal stops the run (the question falls back to its template). Log `stop_details`, show the rep a clear message, and consider the server-side `fallbacks` option on the Claude API.
- **Prompt caching.** The system prompts are below the minimum cacheable length (512 tokens on Sonnet 5.5, 4,096 on Haiku 4.5), so the `cache_control` marker probably does nothing. Check `usage.cache_read_input_tokens`. Today, the savings come from QuoteDesk's own `llm_calls` cache.
- **The response cache.** `llm_calls` keeps full prompts, which include customer email text, with no retention limit. Set a retention period, record cache hits, errors and request ids, and keep it out of the primary database if it grows large.
- **Batches.** Matching sends one call per RFQ, with no splitting. Very large RFQs need to be split into chunks.
- **Model and prompt changes.** Pin model versions and prompt versions, and change either only behind the CI eval gate: the dev eval with Claude must hold the targets for zero wrong automatic parts, zero held text sent and zero held lines priced.
- **Data handling.** RFQ text is sent to Anthropic, after screening. Check the data-retention terms that apply to the distributor's account, and its own policy, before sending real customer email.
- **When Claude is down.** Run on rules only: everything Claude would read or match goes to a person, and the draft says so.

## Security and compliance

- **Export control.**
  - The screening list is owned by compliance, not the four made-up demo terms.
  - Matching runs on normalized text across lines.
  - Only a compliance role can clear a hold, and the audit log records who cleared what and why.
  - Gaps 1 to 3 and 6 above are fixed.
- **Audit.** Append-only is enforced in the database: the trigger, a `TRUNCATE` block and revoked rights for the app role. Rows are copied to write-once storage under a retention policy.
- **Secrets.** The API key and database credentials live in a secrets manager and are rotated. There are no `.env` files in production.
- **Personal data.** RFQ emails carry names, email addresses and phone numbers. Encrypt them at rest, and set retention periods for `rfqs`, `rfq_documents`, `llm_calls` and the stored originals.
- **Network and app.** The network is private, with outbound access only to Claude, the mail system and the ERP. The web app sits behind single sign-on, with CSRF protection on every POST and PATCH.
- **Database roles.** The app role can't change the schema. Migrations run once per deploy under a separate role.

## Reliability and scale

- **Queue and workers.** There is one job per RFQ, with retries, backoff and a dead-letter queue. Ingest is idempotent on the mail message id (today it is idempotent on the fixture id).
- **No transaction is held open during a Claude call.** This is already true; keep it.
- **Timeouts and backpressure.** Every Claude call has a timeout, and a circuit breaker falls back to rules only. Per-RFQ concurrency stays at one, with the database claim replacing today's in-memory lock.
- **Database.** Size the connection pool per instance (today it is fixed at 6), put a pooler in front, and set statement timeouts.
- **Catalog index.** Cache it, and update it from the ERP sync instead of rebuilding it for every RFQ.

## What to watch

- **Time to quote.** Drafting time (p50, p95), and rep time measured from audit timestamps rather than modeled.
- **Matching.** The automatic match rate. Wrong automatic parts found later, which should be zero, with each one reviewed. The "Needs a part" rate.
- **Export holds.** Lines held, time to clear, and held-text guard trips, which should be zero and should page someone.
- **Claude.** Calls, tokens, latency, cost per RFQ, stop reasons and refusals for each prompt version, the cache hit rate, and how often the question falls back to the template.
- **Errors**, by type and route.

## Rollout

1. **Local live test.** Run Claude on the dev split, fix the safety gaps above, and repeat until the eval holds its targets.
2. **Shadow mode.** Run QuoteDesk on real RFQs (with permission, in a controlled environment) and compare its drafts with the quotes reps actually send. Nothing goes to customers. To move on, require zero wrong automatic parts, zero held text sent and zero held lines priced over an agreed number of RFQs, with extraction fields at 0.95 or better.
3. **Assisted.** Reps start from QuoteDesk drafts, with a person approving every line and customer auto-approve rules off.
4. **Customer rules on.** Turn rules on per customer, starting with the narrowest ones, and review every rule-approved line for the first weeks.
5. **Sending.** Send quotes and questions from QuoteDesk once a person has approved them.

## Open questions

- Which mailbox and ERP systems, and through which APIs?
- Who owns the export screening list, and who clears holds?
- How long should RFQ emails, attachments and Claude logs be kept?
- Where does an anonymized eval set of real RFQs come from, and who labels it?
- Should the match threshold differ by customer or category?
