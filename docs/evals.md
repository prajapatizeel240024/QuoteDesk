# Evals

QuoteDesk is measured against 15 synthetic RFQs, each with an answer key. The eval runs the real pipeline on every RFQ, scores what it drafted, then lets a "perfect rep" settle the lines that need a person and scores again. This page covers how the fixtures are made, what's scored, how to run an eval and read the report, and what the numbers can and can't tell you.

## Plan, then render

[`evals/generate.ts`](../evals/generate.ts) (`npm run fixtures`) writes every fixture from a plan, so an answer key never depends on how a file was rendered:

1. **Catalog.** It builds the synthetic catalog (73 parts, 2 of them obsolete and 2 with the made-up export flag), the 4 suppliers and 11 customer part numbers, and writes them to `data/erp/`.
2. **Plans.** It holds one plan per RFQ: the customer, sender, subject, body, format, and every line twice over. One copy is the right answer: part, quantity, unit, need-by date, certs, export hold, and whether a person should review it. The other is the text as the buyer wrote it.
3. **Render.** It writes each plan as a spreadsheet (three customer layouts), a PDF (a table or a numbered list) or a plain email, and checks that every email-only line's quote appears word for word in the body.
4. **Keys.** It works out each line's expected flags and price with its own reference pricing, not with `src/server/pricing`. It also checks that every trap with a matching flag code produces that flag, and stops if one doesn't.
5. **Write order.** It writes `data/erp/` first. Then, before rendering anything, it deletes `evals/rfqs/` and `evals/keys/`, and renders and keys one RFQ at a time. The checks in steps 3 and 4 run as it goes, so a failed check leaves the fixtures half rewritten: fix the plan and run `npm run fixtures` again.

The keys depend on the pricing in `config/quotedesk.yaml`, so change the pricing and you have to run `npm run fixtures` again. `tests/fixtures.test.ts` catches stale keys by comparing every priced key line (63 of them) with `priceLine()`.

## The RFQs

There are 10 dev RFQs (50 lines) and 5 holdout RFQs (23 lines). All six customers appear. Eight RFQs come as spreadsheets, four as PDFs and three as plain email.

| RFQ | Customer | Format | Lines | What it tests |
| --- | --- | --- | --- | --- |
| rfq-01 | Harbor Pump | Spreadsheet | 5 | Customer part numbers, an exact manufacturer number, auto-approval. Needs no Claude. |
| rfq-02 | Cedar Ridge | PDF table | 6 | Lowercase and spaced manufacturer numbers, pack rounding with a minimum line charge, an obsolete part swapped (Cedar Ridge allows it), unicode dashes, a missing date |
| rfq-03 | Harbor Pump | Spreadsheet and email | 7 | The demo: an email-wide date, short stock and a late arrival, the ambiguous "6204", a "TBD" quantity, a quantity break, an obsolete part (Harbor wants to be asked), a description-only valve, and an item only in the email body (read by Claude) |
| rfq-04 | Larkspur Ag | Email only | 3 | Prose read by Claude, a personal mailbox (the customer is found by signature), pack rounding, "a box" meaning a pack, an ambiguous grade, "Friday the 16th" |
| rfq-05 | Bayfront Marine | Spreadsheet | 5 | A US-style date, pack rounding, a cert the part doesn't offer, a rush fee, unclear certs ("Yes") |
| rfq-06 | Summit Packaging | Spreadsheet | 6 | "2,000" and "5k", a quantity break, customer part numbers, auto-approval, a line the buyer marked export-controlled, short stock |
| rfq-07 | Tern Robotics | PDF list | 4 | Two lines held by export screening, a numbered list, a part number inside the text, "1 pack" |
| rfq-08 | Cedar Ridge | PDF table | 5 | A typo (letter O for zero), short stock, a part we don't carry, a late gear motor |
| rfq-09 | Larkspur Ag | Email bullets | 4 | Bullets, feet, our own SKU, pack rounding, a minimum line charge, "2 weeks ARO" |
| rfq-10 | Bayfront Marine | Spreadsheet | 5 | A cert the part doesn't offer, a unicode dash, "ASAP" (not a date), Notes and Total rows |
| rfq-11 to rfq-15 | All but Larkspur | Mixed | 23 | The holdout. Its traps are left out here on purpose. |

In the dev keys, 44 lines have an expected price, 3 should be held for export, 3 should go to a person, and 4 are read by Claude.

## What's scored

[`evals/score.ts`](../evals/score.ts) pairs each drafted line with a key line, then scores the lines in two passes:
- **Auto**: the lines as drafted.
- **After review**: after a perfect rep settles every "Needs a part" line from the key.

| Metric | What it counts | Target |
| --- | --- | --- |
| Recall | Key lines the draft found | 1.00 |
| Extra lines | Drafted lines with no key line | 0 |
| Quantity, unit, date, certs read right | Each field, compared exactly. Certs also compare the "unclear" flag. | 0.95 or better each |
| Wrong parts placed automatically | Lines matched with no person to the wrong SKU, or to a part we don't carry | 0 |
| Auto-match precision | Right SKUs out of all lines matched with no person | 1.00 |
| Lines matched without a person | | Reported only |
| Ambiguous or unknown lines sent to a person | Key lines that expect review and ended up in "Needs a part" | All |
| Export lines held | Key lines with a hold that the draft also held | All |
| Held lines priced | Held lines that got a price | 0 |
| Held text sent to Claude | Held lines whose text appeared in anything sent to Claude | 0 |
| Lines priced exactly like the key | After review. Billed quantity, unit price, extended price, minimum top-up, rush fee, line total and arrival date all match. | All |
| Lines approved by customer rules | | Reported only |
| Customer-rule approvals that were wrong | Rule-approved lines on the wrong SKU | 0 |
| Lines needing a person | Drafts with a non-info flag, in "Needs a part", or held | Reported only |

**How lines are paired.** Table rows pair by document and row. Free-text lines pair by word overlap with the key's quote, and need an overlap score (Jaccard) of at least 0.5.

**How prices are compared.** Prices are compared only when the draft quoted the key's SKU. Margin and ship date aren't compared.

In the report's headline table, every row uses the Auto pass except "Lines priced exactly like the key", which uses After review. The flags table and the per-RFQ "Priced like key" column also use After review.

**Threshold sweep.** The Claude part suggestions on lines that paired with a key line are decided again at thresholds 0.6, 0.7, 0.8 and 0.9. The sweep counts how many would be accepted, and how many of those are wrong or sit on a line the key says should go to a person. It makes no new Claude calls.

**Time to quote.** The eval reports the measured drafting time per RFQ (p50 and p95) and modeled rep minutes, using the assumptions in `evals.time_model` in the YAML:
- Manual: 6 minutes per RFQ plus 4 per line.
- Assisted: 2 minutes per RFQ, plus 0.5 per line that needs no one and 2.5 per line that needs a person.

On the dev split the manual figure is 260 minutes. Both figures are labelled "modeled, not measured".

## Running an eval

```bash
npm run eval -- --split dev                    # the 10 dev RFQs, with Claude
npm run eval -- --split dev --llm oracle       # plumbing check, no API key needed; not a result
npm run eval -- --split dev --no-cache         # fresh Claude calls instead of cached answers
npm run eval -- --split dev --threshold 0.7    # try a different bar
npm run eval -- --split holdout                # once, at the end, with Claude
```

- The eval needs `EVAL_DATABASE_URL`, which must point at local Postgres. Each run migrates and empties the eval database, but keeps `llm_calls`, so identical requests replay from the cache.
- `--split all` runs all 15 RFQs. Using the oracle on anything but `dev` stops with an error.
- Each run writes `evals/reports/<time>-<split>-<anthropic|oracle>.md` and a `.json` with the same name. Reports are gitignored.

To draft a single RFQ and print every line with its price build-up, use `npm run rfq:load -- rfq-03` (add `--llm oracle` to skip Claude).

## Reading a report

The Markdown report has these sections, in order:
1. A header line with the LLM, threshold and cache state. An oracle run is labelled "answer-key stand-in: tests the machinery, NOT a Claude result".
2. **Headline**: the table above, with Auto, After review and Target columns. Only "Lines priced exactly like the key" is filled in from After review.
3. **Time to quote**: measured drafting time and modeled rep minutes.
4. **Flags after review**: expected, found and extra, per flag code.
5. **Threshold sweep.**
6. **Per RFQ** results.
7. **Problems**: every wrong automatic part, price mismatch and held-text leak, each with its line, or "None."
8. **Claude calls**: calls, tokens and p50/p95 latency per purpose, counted from `llm_calls` rows created during the run. A fully cached run shows none, because cache hits write no rows.

## Rules for honest numbers

- **Oracle numbers aren't results.** The README's "all 50 lines found and read, 0 wrong parts, 44/44 prices exact, 3/3 export lines held, 0 held text sent" came from the oracle. It shows the machinery works, not how well Claude does.
- **Claude hasn't been measured yet.** The build sandbox had no API key. The first real numbers come from `npm run eval -- --split dev` with a key.
- **Run the holdout once.** Tune on dev and run the holdout at the end. Because this repository is public, the holdout answer keys in `evals/keys/` can be read by anyone. Treat holdout results as a check on your own process, or move the holdout keys out of the repo before relying on them.
- **Watch the cache.** Cached answers replay across runs. For a fresh measurement, use `--no-cache`. The Claude-calls table counts only calls that weren't cached.

## Limits

- The set is small and synthetic: 15 RFQs, 73 lines, all written by one author. It covers the traps listed above, not the variety of real inboxes.
- "After review" assumes a perfect rep who always picks the key's part.
- The held-text check matches the key's strings (over 6 characters) against what was sent. It doesn't record `already_found`, the subject or the sender. See the known gaps in [AI agents](ai-agents.md#export-screening-and-held-lines).
- The keys' quote date is the UTC date the RFQ arrived, while ingest uses the date in New York. They agree today because every fixture arrives between 12:15 and 20:20 UTC.
- The synthetic-data test in `tests/fixtures.test.ts` scans the email fixtures, the catalog, the suppliers and the YAML. It doesn't scan the attachments or the keys.
