# QuoteDesk docs

The [main README](../README.md) is the short version, and the source of truth for names, layout and rules. These pages go deeper.

| Page | Read it for |
| --- | --- |
| [Architecture](architecture.md) | The parts, how an RFQ becomes a quote, the review screen, the line lifecycle, the write path and audit log, pricing, flags, customer rules, the data model, the API, configuration and the invariants |
| [AI agents](ai-agents.md) | Claude's three jobs (reading free text, picking parts, wording the question to the buyer), what each one sees and returns, the checks after it, the LLM client, export safeguards and the oracle stand-in |
| [Evals](evals.md) | How the 15 synthetic RFQs and their answer keys are made, what's scored, how to run and read an eval, and what the numbers can't tell you |
| [Production plan](production.md) | How QuoteDesk would run for a real distributor, the gaps in today's code to close first, running Claude in production, security, and the rollout. It's a plan only: nothing is deployed. |

## Diagrams

| Diagram | Shows |
| --- | --- |
| [architecture.svg](images/architecture.svg) | The system today, all on one machine |
| [ai-pipeline.svg](images/ai-pipeline.svg) | The three Claude jobs and the checks before and after each one |
| [production-architecture.svg](images/production-architecture.svg) | The planned production design (not deployed) |

All three are SVG files, so you can edit them as text.
