# Statement ingestion

Import bounded CSV/XLSX attachments from an authenticated WhatsApp conversation, capture clear
Transactions, and clarify uncertain rows in that same conversation. Receipt, audio and forwarded-email
ingestion are separate capabilities and are not covered by this map.

| Functionality                    | Local verification                                                                                                          | Production verification, 2026-10-14                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retrieve and admit an attachment | Fixed provider endpoints, signed-link expiry, byte/size/digest verification, admission before media I/O                     | Deployed numeric `file_size` fix verified: header-only CSV reaches the parser; review-only XLSX reaches clarification                                |
| Parse CSV/XLSX safely            | UTF-8, quoting, separators, multiple sheets, inert formulas/hidden cells, malformed files and amplification/row/cell limits | Header-only CSV fails safely; XLSX produces two pending review items. Mixed CSV capture remains pending                                              |
| Stage and publish                | Private R2 ownership, expiry/digest checks, atomic D1 publication, replay and interrupted-publication recovery              | XLSX publication verified in D1: two pending rows, zero captures                                                                                     |
| Capture clear rows               | Mapping, exact Money/Currency, source dates, SourceAttestation, durable chunks and recovery without duplicate capture       | Live capture pending                                                                                                                                 |
| Review uncertain rows            | Bounded evidence, persisted accounting, same-conversation clarification, resolve/skip/abandon and evidence erasure          | XLSX clarification delivered. Skip confirmation blocked by delivery callbacks; QA grant and WhatsApp belong to different Users (isolation confirmed) |
| Enforce authority and budgets    | User isolation, hosted-only submission, request/spend/outstanding limits, Free backfill reservation and settlement          | Unauthenticated reads/submission return 401; missing submission returns `not_found`; read-only CLI excludes submission                               |
| Recover and expire work          | Queue/Workflow replay, terminal failure, staged-object reclamation and preservation of live work                            | Failure reply delivered; live expiry erases both XLSX review rows’ original evidence; interrupted-work recovery not induced                          |

## Evidence and reruns

The existing suites passed: **421 Core tests** with coverage thresholds, **50 parser/media tests**,
**133 Worker/D1 ingestion tests**, and **18 selected hosted-turn tests**. The opt-in processing
measurement also passed with all migrations installed, including 4,096 review rows. These checks
use real local D1/R2/Workers execution and controlled external responses; they do not prove live
provider compatibility.

```sh
bun run --cwd apps/server test:core
bun run --cwd apps/server test src/shell/ingestion/parser.test.ts src/shell/ingestion/parser-limits.test.ts src/shell/ingestion/parser-amplification.test.ts src/shell/ingestion/xlsx-admission.test.ts src/shell/ingestion/operations.test.ts src/shell/ingestion/whatsapp-media.test.ts --coverage.enabled=false
bun run --cwd apps/server test:cloudflare cloudflare/ingestion/statement-ingestion.test.ts cloudflare/ingestion/statement-processing.test.ts cloudflare/ingestion/statement-staging.test.ts cloudflare/ingestion/statement-document.test.ts cloudflare/ingestion/statement-review-budget.test.ts --maxWorkers=1
bun run --cwd apps/server test:cloudflare cloudflare/agent/hosted-turn.test.ts -t 'statement|upload|clarification' --maxWorkers=1
INFRA_PERFORMANCE_MEASURE=1 bun run --cwd apps/server test:cloudflare cloudflare/ingestion/statement-processing.test.ts -t 'measures complete statement processing' --maxWorkers=1
```

Installed capture admission stops the large capture fixtures after 100 captures; completed
Transactions remain committed and accounting settles. This is an application guard, distinct from
Cloudflare D1 quotas. Free backfill is consumed on the first captured Transaction; a zero-capture
terminal failure releases its reservation. Replay protection does not establish semantic deduplication
between independently submitted statements.

Closed local gaps: numeric provider file sizes, quoted-header delimiters and empty leading CSV lines.
Production revealed delivery receipts with identical second-level timestamps: selecting the first
array item rejected valid delivered callbacks. A public webhook regression reproduces the failure;
the comparison now accepts the requested status at the latest timestamp in either order and still
rejects an older status. Captured provider-payload replay passes locally; live verification is pending.

Remaining: verify live clear-row capture, resolve/skip/abandon, replay and cleanup after the delivery
fix deploys. The synthetic CSV/XLSX tests created no Transactions; both XLSX review items expired with abandoned decisions and erased original evidence.
No personal financial evidence was used. The Statement QA grant cannot inspect those rows because
WhatsApp belongs to another test User; no cross-account access was added. Statement QA was revoked, its API credential was refused, and its local copy was cleared.

Owners: [Core decisions](operations.ts), [parser and media operations](../../shell/ingestion/operations.ts),
[native persistence](../../../cloudflare/ingestion/operations.ts), and
[WhatsApp document coordination](../../../cloudflare/agent/internal/statement-document.ts).
