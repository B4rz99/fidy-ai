# Infrastructure performance assessment — 2026-10-10

## Findings and implemented optimization

The recent optimizations address real causes: unindexed retention, repeated source parsing and
progress scans, expensive Reconciliation member joins, and maintenance running inside the cron
CPU envelope. This assessment adds three measured optimizations: unused search-index retirement,
ready-projection History pagination, and constant-cost review-capacity admission. Read-only production
analytics are now available and the resource assessment is complete for the observed traffic. The
[production assessment](infra-performance-production-2026-10-10.md) records seven completed UTC days,
recent release behavior, operation/provider timings and actual deployed startup artifacts.

Production confirms the priorities: Core recorded 6,583 resource-limit failures in the completed
window; its last three observed hours are clean after maintenance relocation. D1 reported 5,442,187
reads on October 9. Two historical coordinator memory failures and 114 canary dead letters warrant
attention when validating recovery and peak memory. The three local improvements have not been
released; their measured savings must not be credited to production yet.

The first optimization: migration
[`0081_retire_projection_search.sql`](../../apps/server/cloudflare/migrations/0081_retire_projection_search.sql)
removes the unused padded-trigram Dashboard search representation and its two maintenance triggers.
Current Dashboard search already reads User-scoped projection leaves through the recent indexes;
no runtime reader of the retired table remains. Capture and Correction were paying to construct
that representation anyway. Retained Transactions, exact decimal aggregates, Reconciliation policy,
search semantics and User isolation remain unchanged.

| Synthetic notes padding | Capture reads before → after | Correction reads before → after | Capture writes before → after | Correction writes before → after |
| ----------------------: | ---------------------------: | ------------------------------: | ----------------------------: | -------------------------------: |
|           32 characters |                      94 → 42 |                       408 → 300 |                       45 → 44 |                        153 → 149 |
|          480 characters |                     542 → 42 |                     1,304 → 300 |                       45 → 44 |                        153 → 149 |
|        1,024 characters |                   1,086 → 42 |                     2,392 → 300 |                       45 → 44 |                        153 → 149 |
|        4,096 characters |                   4,158 → 42 |                     8,536 → 300 |                       45 → 44 |                        153 → 149 |

These lengths are padding appended to a short label, not complete Notes lengths. The 480-character
fixture fits the 500-character Notes domain bound; 1,024 and 4,096 are database-only stress fixtures
that bypass that bound. At valid long Notes, capture reads fall 92.3% and Correction reads 77.0%.

The largest fixture removes 99.0% of capture reads and 96.5% of Correction reads. Native D1 duration
in this run falls from 14 to 1 ms for capture and 29 to 2 ms for Correction. These are coarse local
samples, not production latency percentiles. The write reduction is small. Mutation measurements
cover the direct database operations and migrated triggers, excluding HTTP authority, Audit and
coordination overhead. They must not be treated as complete request costs.

The migration is local and has not been deployed. It deletes derived search state. Rolling back to
an old release that still queries that table would require rebuilding it; the currently deployed
release uses the replacement search path. The repository is in development and does not require
compatibility with historical implementations.

## Evidence boundary

Initial measurements: `ae32d98b31b9ab3f7a95cb77df85c1132cd394b9`. Extended assessment and candidate:
`2284a6e8a3a43bb6a45ea905fe855cd711d5cc87`, with uncommitted changes. Both sets remain in the
measurement artifact so baseline observations are not overwritten.
The public [health endpoint](https://api.fidyapp.com/health) reported the initial revision and
`status: available`; its [production workflow](https://github.com/B4rz99/fidy-ai/actions/runs/38090000323)
completed successfully. This establishes release identity and availability at observation time,
not production performance or sustained maintenance success.

Local environment: macOS arm64, repository-pinned Bun `1.4.3-canary.1+13a98b0db`, frozen lockfile,
Miniflare `5.20260911.1-alpha`, workerd `1.20261001.1`, Vitest `5.0.3`, Playwright `1.63.0`, Vite
`8.3.2`. Native D1 counters include real SQLite index/trigger work. Synthetic records and browser
providers do not establish real traffic distributions, provider latency, or regional network latency.

The read-only [production inspection](https://github.com/B4rz99/fidy-ai/actions/runs/38092671954)
completed on `2284a6e8a`: release routing passed and the declared topology had no drift. Its workflow
does not collect usage or latency. Subsequent direct API access using the supplied private read-only
token succeeded; local Wrangler OAuth is not required for that collection.

The completed production window covers October 3–9 UTC; October 10 is a partial observation. Actual
resource usage, database bytes, Worker CPU/outcomes, DO memory errors, queue backlog/retries,
Workflow statuses, AI usage, R2 operations and provider completion timings were collected. The account
returns R2 Paid but no Workers Paid subscription; Free allowance comparisons remain conditional.
The deployment observed during collection advanced independently to `d8be4d7ea7`. Representative
mixed User load, all 68 endpoint CPU distributions and hosted document peak memory remain evidence
gaps. No production load test, deployment or account change was performed.

Published platform facts and primary sources are in the
[capacity reference](infra-platform-capacity-2026-10-10.md); local observations are in
[the measurements file](infra-performance-measurements-2026-10-10.json), and sanitized production
aggregates are in [the production artifact](infra-performance-production-2026-10-10.json).

## Review of recent work

| Area                       | Evidence and assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission/retention        | The documented incident consumed 5,438,075 reads, with six sweeps accounting for 4,691,521. Partial indexes and bounded 128-record sweeps address the scan cause. Native retention tests pass; this does not quantify the entire idle maintenance tick. See [retention analysis](../operations/d1-admission-retention.md).                                                                                                                                                                                                                                                                                                                   |
| Reconciliation queries     | The indexed member point reads avoid the prior pair-by-history multiplication. Foreign User histories do not increase the existing native query budget. The new ready-projection History path removes whole-history sorting from ordinary pages; fallback still uses the authoritative source during repair.                                                                                                                                                                                                                                                                                                                                 |
| Dashboard search           | Common recent matches stop early; rare/absent searches can scan the requesting User's own history. The native search-cost tests pass. This is a bounded User scope, not constant work. Retiring the unused global derived representation removes unrelated write-path work.                                                                                                                                                                                                                                                                                                                                                                  |
| Exact aggregate Correction | The bucket/digit primary-key prefixes and indexed occurrence ranges preserve exact decimal arithmetic and pre-epoch bounds. Native upgrade, maximum replacement and correction tests pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Statement processing       | Durable materialization avoids rereading/parsing the original source every activity. Progress tests retain equal next-activity reads across 32 versus 4,096 prior receipts: 297 accounting / 4,991 total reads in either fixture. Recovery after partial failure stays at 725 reads. Whole processing in the minimal fixture remains 15,215 / 58,055 reads for 96 / 192 rows; its accounting portion is 1,104 / 2,196. The extended full-migration benchmark confirms the global pending-review count causes quadratic reads; migration 0082 fixes that scan, as detailed below. See [statement work bounds](statement-work-bounds-1140.md). |
| Maintenance CPU            | Core cron now delegates to a reserved instance in the existing private `UserTransactionCoordinator` namespace. This addresses cron execution's CPU boundary, not its D1 demand. Native executor, failure isolation and live-attempt preservation tests pass.                                                                                                                                                                                                                                                                                                                                                                                 |
| Queue/outage handling      | Failure isolation and retention tests pass. R2-backed alert delivery avoids depending solely on an exhausted D1 database. Current active backlogs are zero; the DLQ reports 114 messages. Historical canary retries are measured, while sustained product recovery throughput remains unobserved.                                                                                                                                                                                                                                                                                                                                            |
| Browser costs              | Fresh production-mode local browser scenarios pass. Cancellation/unmount/authentication replacement stop follow-up work; payment visibility suspension works. Hidden provider status still makes three observations for six D1 reads. Navigation costs include real Audit/admission writes and rate-limit retries; preserve `no-store`, authentication boundaries and authoritative settlement. See [browser cost analysis](browser-request-costs-1156.md) and the new measurements.                                                                                                                                                         |

## Growth and resource envelope

### History

Native history measurements include an equally large foreign User history, full current migrations,
restored projection triggers, and no `ANALYZE`. They select up to 101 effective Transactions.

| Owned Transactions | Unlinked rows read | Fully linked rows read | Linked native D1 duration |
| -----------------: | -----------------: | ---------------------: | ------------------------: |
|                200 |                102 |                  4,302 |                      2 ms |
|              2,000 |                102 |                 43,002 |                     11 ms |
|             20,000 |                102 |                430,002 |                    116 ms |

The smallest linked fixture returns 100 effective Transactions; the other pages return 101.
This demonstrates linear owned-history work, not the previous quadratic pair join. At 20,000
fully linked Transactions, eleven such pages alone consume nearly the published 5 million daily
Free D1 reads. This is a database-operation illustration, not an eleven-request production allowance:
maintenance and every other request also consume reads. The single primary serializes database
work, so this cost also increases contention even on a paid plan.

The second optimization uses the existing exact effective projection only when its version is current
and readiness is `ready`. During every repair state, a missing state or unsupported version, it
uses the same authoritative effective-fact policy as before. Readiness, authority and selected rows
remain in one SQL snapshot. SQLite's [lazy CASE semantics](https://www.sqlite.org/lang_expr.html#the_case_expression)
select the branch; a UNION alternative still materialized the expensive inactive view in native tests.
Only the bounded 101-row page is encoded to JSON and decoded back to rows.

Candidate reads are **304** at 200, 2,000 and 20,000 unlinked Transactions, and **302 / 304 / 304**
for linked Transactions. This reduces the 20,000-linked fixture by **99.93%**, at the cost of increasing
unlinked-page reads from 102 to 304 through bounded serialization. Filters and ordering operate on
effective facts. Tests compare the authoritative oracle across filters, corrections, foreign histories,
statistics and repair states; clearing the projection proves the fallback does not depend on its rows.
Existing HTTP/browser pagination tests exercise cursors and authentication replacement. Arbitrary
substring searches and low-selectivity filters can still scan owned leaves; bounded output is not
proof of bounded scan work for every filter.

### Complete statement processing

Full migrated D1 and native R2 processing of malformed CSV rows exposed three global pending-review
counts per new review item, including the capacity trigger. This makes total reads quadratic despite
linear outcome accounting. The third optimization, migration
[0082_statement_review_capacity.sql](../../apps/server/cloudflare/migrations/0082_statement_review_capacity.sql),
maintains a singleton exact count in the same commit as insertion, settlement or deletion. Admission
and the database's hard 5,000-row cap read that count; absent capacity fails closed.

| Review rows | Full-chain reads before | Full-chain reads after | Writes before → after |
| ----------: | ----------------------: | ---------------------: | --------------------: |
|          96 |                  15,217 |                  1,918 |             793 → 889 |
|         192 |                  58,057 |                  3,814 |         1,570 → 1,762 |
|       1,024 |               1,587,487 |                 20,252 |         8,304 → 9,328 |

At 1,024 rows the read reduction is **98.7%**, with one additional counter write per retained review
item. Equal warm next activities now read 559 total / 297 accounting rows at both 32 and 4,096 prior
receipts, versus 4,991 total before. A populated upgrade test verifies initialization, exact capacity,
expiry, deletion, failed admission and batch rollback. Existing resolution tests retain the guarded
settlement lifecycle. These scenarios measure needs-review processing, not every accepted-document
mix or full Workflow/provider cost. Additional writes must be included in capacity planning.

### Idle work and daily budgets

The topology has one D1 primary with replication disabled, one coordination DO class, three R2
buckets, ten queues and eight Workflow definitions. Core ticks every minute and ForwardedEmail
every five minutes: 1,728 cron firings/day. All account resources compete for their product's
allowance; declarations do not prove the account's plan or actual remote inventory.

Complete Core idle ticks execute all 41 scheduled activities with full migrations, native D1/R2,
synthetic Queue metrics/offers and coordinator readiness, fresh canary evidence and default-disabled
weekly delivery. Warm ticks read **289 rows and write 23**, unchanged by 2,000 unexpired admission
events. The first empty tick reads 247 and writes 44. Twenty-one warm writes publish health freshness;
two come from PAT sweep evidence. Each tick offers one canary and requests seven Queue metrics.
The idle Email tick reads **4 rows, writes zero**, at its five-minute cadence.

Extrapolating those warm fixtures gives **417,312 D1 reads and 33,120 writes/day**, before canary
consumption, Workflow work, delivery, expired retention, User activity and other account resources.
That is 8.35% of published Free reads and 33.12% of Free writes. This is a synthetic lower workload
baseline, not a measured production floor. With a 20% account reserve, 46,880 writes remain before
other background work: at most 1,065 direct captures or 314 direct Corrections, excluding request
authority, Audit and admission overhead. Freshness and health recovery are correctness requirements;
removing their writes or reducing cadence needs an explicit outage-detection target.

Enabled operational monitoring publishes a Queue canary each Core tick. Its payload rounds to a
five-minute period; Workflow identity is deduplicated, Queue offers are not. Assuming every tick
succeeds, small messages and no retries: 1,440 messages/day × three operations = **4,320 Queue
operations/day**, 43.2% of the published 10,000 Free allowance. One completed Workflow per period
uses 288 steps/day, 9.6% of the published 3,000 Free steps. Retried/ambiguous offers and dead letters
can increase costs. Deduplicate offers only with a recovery design that preserves the ten-minute
staleness detection; reducing monitoring blindly changes outage detection.

With an illustrative 20% account reserve, canaries leave 3,680 Queue operations, about 1,226
additional successful small messages/day, before other background work or retries. Workflow steps
leave 2,112 for product activities. These are workload ceilings under assumptions, not User capacity.

D1's 100,000 daily Free writes independently constrain traffic. A capture's 44 measured trigger
writes permits at most 2,272 such direct mutations/day if nothing else writes; 149 writes per
Correction permits at most 671. Real request costs and maintenance make both ceilings lower.
Use `baseline + Σ(action count × measured cost)` separately for reads, writes, Queue operations,
Workflow steps, AI neurons and R2 operations. Apply the reserve to the account allocation, not to
each resource declaration. The primary's published Free storage cap is 500 MB; the 5 GB account
cap cannot be assigned to this single database.

### CPU, memory and external dependencies

The current XLSX proof accepts the bounded 8,000-row fixture in 743 ms elapsed / 746 ms sampled V8
activity, with 54.4 MB retained heap afterward. Two overlapping bounded requests both succeed in
1,427 ms elapsed, with 51.1 MB retained heap afterward. Retained samples are not peak isolate
memory, and overlap on one local worker does not establish fleet capacity. Parsing and evidence
encoding are larger CPU consumers than polling.

The published Free Workflow CPU documentation describes a 10 ms boundary but is inconsistent
about whether it is per step or invocation. The local proof configures a 30-second CPU allowance;
it does not prove Free-plan execution. Verify the account plan and actual parse-step outcomes before
promising supported XLSX ingestion. Core maintenance's DO relocation gives it a different CPU
envelope, while HTTP paths and parsing Workflows still require their own checks.

The isolate memory limit is 128 MB, shared by concurrent requests. Measure actual peak memory
through worst accepted documents, failures, GC pressure and concurrent work before increasing
concurrency. Queues currently batch ten messages with three retries; batching reduces invocations,
not message operations. More consumer concurrency can increase pressure on the same D1 primary.

Workers AI is another independent Free constraint: for the configured model, a hypothetical
10,000-input / 1,000-output-token inference uses about 118.2 neurons, roughly 84/day within 10,000
neurons before any other inference. Turns may invoke it repeatedly. Record returned usage per
inference and total per Turn. Email, WhatsApp, payment and identity providers need separate timing,
rate-limit and retry observations; synthetic browser providers cannot supply them.

## Local startup and concurrency boundaries

A finite native D1 exercise issued 64 History queries at concurrency 1, 8 and 32 against a
20,000-record linked fixture. Each level read exactly 19,456 rows (304/request). Observed local
p50/p95 elapsed times were 10/68, 79/202 and 304/363 ms respectively. The run confirms bounded
query work under overlap; it does not establish production concurrency limits or an HTTP SLO.

Startup was profiled with two build pipelines. The standalone pinned Alchemy WorkerBundle uses
its Cloudflare Rolldown plugins, default PurePlugin and production minification; Wrangler packages
its already-built output with `no_bundle: true`. The local packages have no resource bindings and
are not the exact deployed release artifact.

| Alchemy-built Worker | Upload KiB | Gzip KiB | Sampled active startup CPU | Included GC |
| -------------------- | ---------: | -------: | -------------------------: | ----------: |
| Public               |     473.52 |   132.10 |                   247.5 ms |     37.8 ms |
| Core                 |   2,750.85 |   742.10 |                   488.6 ms |     25.4 ms |
| Email                |   1,222.46 |   331.16 |                   303.2 ms |     24.6 ms |

An earlier plain Wrangler build produced Public/Core/Email packages of approximately
1.46/5.64/2.91 MiB uncompressed and sampled startup CPU of 773/2,513/1,284 ms. These different
compiler outputs cannot establish an application regression or speedup. The Alchemy samples give a
more relevant local baseline. The subsequent authenticated assessment downloaded the actual deployed
modules with their real compatibility flags: local active startup measured 82.7 ms Public, 192.3 ms
Core and 111.4 ms Email. These remain local CPU measurements; no hosted startup timing was exposed.
No new startup optimization is justified by these samples alone.

## Priorities and validation

1. The seven-day read-only resource baseline is complete, including current release observations,
   metadata-only operation/provider timings and actual deployed bundles. Preserve the coverage
   boundaries: development/release traffic does not establish mixed User capacity; subscription
   discovery did not prove Workers Paid.
2. Deploy the three tested optimizations through the normal release path and compare per-operation
   read/write/CPU distributions and search outcomes on the deployed revision. No deployment occurred
   in this assessment.
3. Characterize rare substring searches, mixed accepted/review statements, sustained queue backlog
   recovery and actual provider delay. History and review-capacity growth fixes are implemented locally.
4. Budget and, if needed, reduce canary offer duplication with explicit failure recovery. Verify
   parse CPU under the account plan and measure peak isolate memory before raising concurrency.
5. Run staged concurrency tests against a representative isolated topology, including queue backlog
   recovery and provider delay/failure. Define latency/error targets from product needs, then derive
   sustainable activity mixes and burst limits. No production saturation test has been run.

Final validation: the complete native suite passed **1,743 tests**, with **14 skipped**, across
132 files (131 passed / one skipped) in 726.96 seconds using one worker. The complete browser
suite passed **78 tests**, with three skipped. Type checking, type-aware lint, formatting and the
other static verification groups passed. The final opt-in History growth/concurrency run passed
all seven tests; full-schema write-cost, statement and maintenance measurements are retained in
the machine-readable artifact.

Two earlier parallel native runs were not clean: eight failures in two files in the first, then six
PAT failures in the second. The first affected files passed all 72 active tests on both an isolated
pristine baseline and the candidate; the PAT file separately passed all 52 tests. The second run's
trace identifies a Miniflare synchronous IPC message-id assertion. The complete serial pass resolves
candidate validation, while the parallel harness instability remains a tooling observation rather
than a demonstrated application regression.

The [coverage inventory](infra-performance-coverage-2026-10-10.md) lists every infrastructure resource,
all 68 canonical operations and the remaining measurement boundaries. Functional test coverage does
not establish endpoint CPU distributions or production sustained capacity. No plan change, deployment
or production saturation test has been performed.

Reproduce with the pinned Bun directory on `PATH`:

```sh
bun run verify -- --group static
bun run --cwd apps/server test:cloudflare --maxWorkers=1
INFRA_PERFORMANCE_MEASURE=1 bun run --cwd apps/server test:cloudflare --maxWorkers=1 \
  cloudflare/transactions/query-costs.test.ts cloudflare/transactions/projection-write-costs.test.ts \
  cloudflare/maintenance/performance.test.ts cloudflare/ingestion/statement-processing.test.ts
bun scripts/document-parsing/xlsx-work.ts
cd apps/web
BROWSER_COST_MEASUREMENT=1 bun ../../node_modules/@playwright/test/cli.js test \
  --config playwright.config.ts browser-cost.spec.ts
```
