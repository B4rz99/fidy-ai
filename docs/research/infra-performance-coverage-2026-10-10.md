# Infrastructure performance coverage — 2026-10-10

Assessment revision: `2284a6e8a3a43bb6a45ea905fe855cd711d5cc87`, with local candidate changes.
This inventory distinguishes measured work, functional proof and unavailable production evidence.
It is not a claim that every endpoint or traffic mix has been benchmarked.

## Resource and execution coverage

| Surface                                         | Completed evidence                                                                                                                                                                                                  | Remaining measurement                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Public Ingress → private Core → static Web      | Native/browser journeys; release routing and topology drift inspection; actual deployed artifacts profiled locally; production Worker/asset aggregates                                                              | Production regional latency, per-operation CPU and memory, cold/warm tails                      |
| Canonical API                                   | Complete catalog below; native security/authority, transaction and owner tests                                                                                                                                      | Per-operation latency/CPU/resource distributions for all 68 operations; sustained traffic mixes |
| D1 primary                                      | Full-migration write costs; effective History at 200/2k/20k own and foreign records; Correction, search and aggregate invariants; complete review processing; every idle schedule; production rows/duration/storage | Individual operation attribution, long-term growth and contention; rare-filter worst cases      |
| UserTransactionCoordinator                      | Native coordination/rollback/replay/failure tests; private maintenance execution tests; production namespace compute/errors/memory                                                                                  | Hot-User contention and alarm recovery under representative load                                |
| Core maintenance                                | All 41 activities invoked and measured; 0/2k live admission records, first/warm ticks; per-activity D1/elapsed evidence; production cron CPU/outcomes                                                               | Populated due work, expired cleanup, disabled feature activation and backlog recovery           |
| Email maintenance                               | Both activities, full schema, first/warm idle ticks; production cron outcomes                                                                                                                                       | Populated delivery/expiry and provider latency                                                  |
| Ten Queues / nine consumers                     | Existing failure isolation, retry/ack/dead-letter proofs; idle offers/metrics and daily platform budget model; production canary retries/DLQ/current backlog                                                        | Sustained backlog age, throughput, retry amplification and recovery under provider delay        |
| Eight Workflows                                 | Existing parsing, replay, failure/reconciliation and canary proofs; published step/CPU limits checked; production lifecycle/step aggregates and current instance counts                                             | Workers plan confirmation, hosted parse-step CPU and product completion tails                   |
| Three R2 buckets                                | Native ingestion/staging/retention behavior and XLSX/source sizes; production bytes/objects/operations                                                                                                              | Peak accepted-document mix, monthly billing and lifecycle lag                                   |
| Hosted AI                                       | Model pricing, resource admission and provider boundary proofs; production tokens/neurons and timing                                                                                                                | Representative Turn cost, stable provider tails and concurrency                                 |
| Email / WhatsApp / payment / Google / Microsoft | Native/synthetic integration journeys and failure handling; available Resend/Kapso timing aggregates                                                                                                                | Actual provider p50/p95/p99, throttling, timeout and retry costs                                |
| Build / deployment                              | Recent CI/verification optimizations inspected; frozen dependencies, local static checks, dry-run packages, read-only production inspection                                                                         | Hosted startup CPU; CI trends across comparable runners                                         |

Native History concurrency exercises 64 queries at 1/8/32 callers against one local D1 binding.
It excludes HTTP, DO authority, providers and network regions. Row costs remain bounded; local
latency results are sensitive to competing work and are not production SLO or saturation evidence.
Startup profiles cover standalone pinned Alchemy bundles and a separate Wrangler build; neither is
the exact deployed release artifact. Published
platform bounds and the machine-readable evidence are linked from the main assessment.

## Canonical operation inventory

Catalog extracted from `apps/server/src/shell/api.ts` and its assembled `operationCatalog`.
Each operation still requires its own production runtime distribution; a native correctness test
or a browser journey does not imply that measurement exists.

| Family              | Operations |
| ------------------- | ---------: |
| browserLogin        |          1 |
| budgets             |          6 |
| categories          |          5 |
| connections         |          4 |
| dashboard           |          5 |
| emailAuthentication |          2 |
| identity            |          2 |
| ingestion           |          8 |
| insights            |          7 |
| memory              |          4 |
| operations          |          1 |
| pats                |          7 |
| quota               |          1 |
| recovery            |          1 |
| recurring           |          1 |
| subscription        |          4 |
| transactions        |          9 |

| Operation                                      | Method | Route                                   |
| ---------------------------------------------- | ------ | --------------------------------------- |
| `browserLogin.approvePairing`                  | POST   | `/browser-login/pairings/approve`       |
| `identity.getCurrentUser`                      | GET    | `/user`                                 |
| `identity.updateUserPreferences`               | PATCH  | `/user/preferences`                     |
| `categories.listCategories`                    | GET    | `/categories`                           |
| `categories.listKeywordRules`                  | GET    | `/category-keyword-rules`               |
| `categories.createKeywordRule`                 | POST   | `/category-keyword-rules`               |
| `categories.updateKeywordRule`                 | PUT    | `/category-keyword-rules/:id`           |
| `categories.deleteKeywordRule`                 | DELETE | `/category-keyword-rules/:id`           |
| `budgets.createBudget`                         | POST   | `/budgets`                              |
| `budgets.listBudgets`                          | GET    | `/budgets`                              |
| `budgets.getBudget`                            | GET    | `/budgets/:id`                          |
| `budgets.updateBudget`                         | PUT    | `/budgets/:id`                          |
| `budgets.deleteBudget`                         | DELETE | `/budgets/:id`                          |
| `budgets.getBudgetStatus`                      | GET    | `/budget-status`                        |
| `connections.listInstitutions`                 | GET    | `/institutions`                         |
| `connections.connectInstitution`               | POST   | `/connections`                          |
| `connections.listConnections`                  | GET    | `/connections`                          |
| `connections.getConnection`                    | GET    | `/connections/:id`                      |
| `dashboard.initializeDashboard`                | POST   | `/dashboard/initialize`                 |
| `dashboard.getDashboard`                       | GET    | `/dashboard`                            |
| `dashboard.getDashboardView`                   | GET    | `/dashboard/view`                       |
| `dashboard.listDashboardCatalog`               | GET    | `/dashboard/catalog`                    |
| `dashboard.applyDashboardEdit`                 | POST   | `/dashboard/edits`                      |
| `emailAuthentication.requestEmailReplacement`  | POST   | `/email/replacement`                    |
| `emailAuthentication.completeEmailReplacement` | POST   | `/web/email/replacement/verify`         |
| `transactions.createTransaction`               | POST   | `/transactions`                         |
| `transactions.listTransactions`                | GET    | `/transactions`                         |
| `transactions.searchTransactions`              | GET    | `/transactions/search`                  |
| `transactions.getTransaction`                  | GET    | `/transactions/:id`                     |
| `transactions.linkTransactions`                | POST   | `/transactions/link`                    |
| `transactions.unlinkTransactions`              | POST   | `/transactions/unlink`                  |
| `transactions.updateTransaction`               | PUT    | `/transactions/:id`                     |
| `transactions.deleteTransaction`               | DELETE | `/transactions/:id`                     |
| `transactions.listSourceAttestations`          | GET    | `/transactions/:id/source-attestations` |
| `ingestion.enableEmailForwarding`              | POST   | `/ingestion/email-forwarding`           |
| `ingestion.getEmailForwarding`                 | GET    | `/ingestion/email-forwarding`           |
| `ingestion.submitForExtraction`                | POST   | `/ingestion/statements`                 |
| `ingestion.getStatementSubmission`             | GET    | `/ingestion/statements/:id`             |
| `ingestion.listNeedsReviewItems`               | GET    | `/ingestion/needs-review`               |
| `ingestion.resolveNeedsReviewItem`             | POST   | `/ingestion/needs-review/:id/resolve`   |
| `ingestion.skipNeedsReviewItem`                | POST   | `/ingestion/needs-review/:id/skip`      |
| `ingestion.abandonStatementSubmission`         | POST   | `/ingestion/statements/:id/abandon`     |
| `insights.getRecurringDigestReport`            | GET    | `/insights/recurring/:id`               |
| `insights.getReminderSchedule`                 | GET    | `/insights/reminder`                    |
| `insights.updateReminderSchedule`              | POST   | `/insights/reminder`                    |
| `insights.listPendingInsights`                 | GET    | `/insights/pending`                     |
| `insights.markInsightDelivered`                | POST   | `/insights/:id/delivered`               |
| `insights.markInsightRead`                     | POST   | `/insights/:id/read`                    |
| `insights.dismissInsight`                      | POST   | `/insights/:id/dismissed`               |
| `recurring.listRecurringSeries`                | GET    | `/recurring-series`                     |
| `memory.remember`                              | POST   | `/memories`                             |
| `memory.revise`                                | PUT    | `/memories/:id`                         |
| `memory.forget`                                | DELETE | `/memories/:id`                         |
| `memory.recall`                                | GET    | `/memories`                             |
| `subscription.getUpgradeUrl`                   | GET    | `/subscription/upgrade-url`             |
| `subscription.listSubscriptionOffers`          | GET    | `/subscription/offers`                  |
| `subscription.getSubscriptionStatus`           | GET    | `/subscription/status`                  |
| `subscription.cancelSubscription`              | POST   | `/subscription/cancellation`            |
| `quota.getQuota`                               | GET    | `/quota`                                |
| `pats.listPATs`                                | GET    | `/pats`                                 |
| `pats.getPATActivity`                          | GET    | `/pats/:shortId/activity`               |
| `pats.revokePAT`                               | DELETE | `/pats/:shortId`                        |
| `pats.revokeAllPATs`                           | DELETE | `/pats`                                 |
| `pats.createManualPAT`                         | POST   | `/pats`                                 |
| `pats.inspectPATPairing`                       | POST   | `/pats/pairings/inspect`                |
| `pats.approvePATPairing`                       | POST   | `/pats/pairings/approve`                |
| `recovery.rotateBackupRecoveryCode`            | POST   | `/recovery/backup-code/rotate`          |
| `operations.executeAtomicBatch`                | POST   | `/operations/atomic-batch`              |

## Production baseline and remaining evidence

The supplied read-only token unblocked direct analytics collection. The
[production assessment](infra-performance-production-2026-10-10.md) and
[sanitized aggregate artifact](infra-performance-production-2026-10-10.json) cover seven completed
UTC days, a recent partial day and deployed revision/artifact identity. Worker CPU/outcomes, D1
rows/duration/storage, DO memory/errors/compute, queue retries/backlogs/dead letters, Workflow
steps/statuses, AI usage, R2 storage/operations, asset cache outcomes and available provider timing
populations are measured. Alchemy's state Worker/Store are included in the actual account inventory.

The API returned R2 Paid but no Workers Paid subscription; `standard` usage_model alone does not
establish the plan. Production operation logs label Worker/work/provider families, not every
canonical API operation. Sparse development traffic and zero product Workflow instances cannot
establish sustained User capacity, queue recovery, hosted document peak memory or all-provider tails.
These remain workload gaps rather than credential gaps. The candidate has not been deployed, so
its savings are locally verified rather than measured in production.

The [aggregate baseline query](infra-performance-production-baseline.graphql) was verified against
the account schema and executed successfully. Its supplemental resource queries select metadata
only. Retain effective bounds, sampling intervals, units and release identity; never add or average
percentiles across groups. Telemetry calculations must use `dry: true` and omit event content,
request bodies/headers, financial facts and SQL text/bindings.

Sources: [Workers analytics query](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/),
[D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/).
