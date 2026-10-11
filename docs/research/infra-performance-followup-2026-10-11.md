# Infrastructure performance follow-up — 2026-10-11

## Scope and evidence boundaries

All 68 declared canonical operations were assessed. Successful native fixture measurements cover 66 operations after measuring the deletion owner newly installed on trunk. `identity.updateUserPreferences` and `transactions.listSourceAttestations` have no installed canonical owner. Their feature performance cannot be measured; implementing those features is outside infrastructure optimization. No result here establishes production traffic capacity or a production latency SLO.

The adjacent JSON preserves separate cohorts and cost boundaries. Direct Core D1 excludes coordinator and provider work; held-owner D1 excludes transport admission. Do not add these overlapping observations. Host-process CPU excludes workerd and is not Worker CPU. Integration fixtures include adversarial cases and variable local contention. The initial full-suite pilot is exploratory because its observer was refreshed during execution. A separate pinned full-suite run and the focused cohorts provide repeatable evidence.

## Shipped database optimization

PR #1194 removed unused trigram FTS and replaced pending-review scans with an atomic capacity counter. Controlled fixture comparisons: capture 542 → 42 D1 reads (92.3% reduction); correction 1,304 → 300 (77.0%); linked 20,000-row history 430,002 → 304 (99.93%). Unlinked history increased from 102 → 304 reads. Processing 1,024 items fell from 1,587,487 → 20,252 reads (98.7%); writes increased from 8,304 → 9,328 (12.3%). These are fixture comparisons, not attributable production percentages.

## Web delivery

PR #1201 splits additional routes with TanStack Router preload-aware lazy loading and serves full-glyph WOFF2 fonts. Three alternating cold contexts per version used Pixel 5 emulation, 4× CPU slowdown, 1.6 Mbps download, 750 Kbps upload and 150 ms latency. Local gzip delivery, cache disabled, external requests blocked. Downloaded response bodies: 890,043 → 638,558 bytes (28.3% reduction). Median lab LCP: 3,216 → 2,440 ms (24.1% reduction). All six samples and conditions are in the JSON. This is not production Core Web Vitals.

Web verification: 418 unit tests in UTC, 78 browser tests with 3 existing skips; typecheck and build passed. Font glyph mapping, metrics and glyph order match the original fonts. Router preload preserves recovery disclosure cleanup.

Pinned native verification at `93fdd16c2`: 133 files and 1,772 tests passed, with 1 file and 15 tests skipped (521.84 seconds). The final observer logic is unchanged; its file moved into the server TypeScript project for correct type-aware lint resolution. The web PR merged as `6f5c3bf70b1d576269a2508d00cb7df56357f035`; deployment run 38139226567 refused at the exhausted AI gate before promotion.

## Mixed and hot-User load

832 native public requests exercised the actual D1 and SQLite User coordinator adapters: one hot User and two balanced Users, paced concurrency 2 and burst concurrency 2/8/32. Both paced scenarios accepted all 32 requests. Burst refusals preserve the existing per-User admission policy. Accepted writes equal retained transactions per User; no canonical request lease remained. Offered throughput and accepted throughput are reported separately.

| Users | Concurrency | Offered | Accepted | 429 | Accepted p95 ms |
| ----: | ----------: | ------: | -------: | --: | --------------: |
|     1 |           2 |      32 |       32 |   0 |           62.02 |
|     1 |           2 |     128 |       10 | 118 |           47.14 |
|     1 |           8 |     128 |       10 | 118 |          137.81 |
|     1 |          32 |     128 |        8 | 120 |          485.24 |
|     2 |           2 |      32 |       32 |   0 |           51.32 |
|     2 |           2 |     128 |       22 | 106 |           49.15 |
|     2 |           8 |     128 |       22 | 106 |          220.41 |
|     2 |          32 |     128 |       17 | 111 |          493.51 |

Some runs overlapped local owner checks. These values characterize the fixture and admission behavior; they do not establish a production maximum or multi-tenant population capacity.

## Queue recovery

An isolated native Miniflare Queue proof offers 100 eligible statement identities, including one poisoned handoff. Miniflare retries the entire failed 10-message batch despite individual acknowledgments: 130 deliveries and 10 dead letters, while 99 healthy identities reach unique Workflow handoffs. After restoring the synthetic dependency and reoffering eligible owner identities, all 100 identities have exactly one handoff after 230 total deliveries. The test passes under this conservative local behavior. Workflow completion is not simulated; its boundary is a synthetic handoff adapter.

Existing Core failure-isolation tests cover poison positions, lost acknowledgments and ambiguous Workflow creation. Cloudflare documents that local Queue consumer concurrency is unsupported; the local broker behavior does not prove production acknowledgment isolation. The existing production DLQ's 114 messages were not replayed or deleted. The zero oldest-message timestamp leaves their age unknown. Recovery requires owner-state reconciliation rather than blindly replaying retained payloads.

## XLSX runtime measurements

The protected-trunk workflow runs the binding-free parser against an isolated Cloudflare remote preview, using existing production-environment credentials. It does not bind production D1, R2, Queues or routes. Hosted results are pending this workflow's first completed run.

Local workerd: 1,000 statement rows parsed and interpreted successfully; 8,000 × 12 synthetic cells accepted within bounds; 20,000 × 12, formatted expansion and numeric expansion fixtures refused. Two concurrent bounded parses succeeded. The 8,000-row synthetic headers produce zero interpreted transactions by design. CDP CPU profiles report sampled V8 work; before/after heap reports retained V8 heap, excluding a guaranteed peak or external-buffer accounting. No 128 MB peak-memory claim is made.

## Production verification

Earlier release verification recorded successful promotion, smoke, drift and retirement gates; D1 schema and capacity-counter triggers matched the release. Post-release D1 p95 was 0.91 ms in ENAM, observed Durable Object sample maximum was 20.54 MB, active Queues were empty and no CPU, memory or fatal errors were observed. Traffic was low development/CI/smoke/canary volume. The follow-up web deployment and hosted parser run still require their final recorded evidence. Three newer production runs (38136020384, 38137254930, 38138130053) failed the live Workers AI gate before promotion. A direct synthetic API check confirmed HTTP 429 / REST error 4006: the account exhausted its daily free allocation of 10,000 neurons. Read-only access works. Repeated retries cannot resolve this daily limit; promotion needs the quota reset or an account billing change. The gate remains intact. The 11:50–12:20 UTC observation has D1 p95 0.95 ms, coordinator memory sample maximum 20.82 MB and zero coordinator resource errors. Scheduled invocations include 33 successes and one exception at 12:06:10 UTC; structured logs identify the failed activity as `async.health`. The provider/root cause is unresolved, so this is not reported as a clean window.

## References

- [Workers AI pricing and daily reset](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Remote development](https://developers.cloudflare.com/workers/local-development/)
- [Memory inspection](https://developers.cloudflare.com/workers/observability/dev-tools/memory-usage/)
- [Queue local-development limits](https://developers.cloudflare.com/queues/configuration/local-development/)
- [TanStack lazy route component](https://tanstack.com/router/latest/docs/api/router/lazyRouteComponentFunction)

## Operation coverage

| Operation                                      | Assessment                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `browserLogin.approvePairing`                  | measured successful native fixture                                            |
| `identity.getCurrentUser`                      | measured successful native fixture                                            |
| `identity.updateUserPreferences`               | declared operation without installed canonical owner; performance unavailable |
| `categories.listCategories`                    | measured successful native fixture                                            |
| `categories.listKeywordRules`                  | measured successful native fixture                                            |
| `categories.createKeywordRule`                 | measured successful native fixture                                            |
| `categories.updateKeywordRule`                 | measured successful native fixture                                            |
| `categories.deleteKeywordRule`                 | measured successful native fixture                                            |
| `budgets.createBudget`                         | measured successful native fixture                                            |
| `budgets.listBudgets`                          | measured successful native fixture                                            |
| `budgets.getBudget`                            | measured successful native fixture                                            |
| `budgets.updateBudget`                         | measured successful native fixture                                            |
| `budgets.deleteBudget`                         | measured successful native fixture                                            |
| `budgets.getBudgetStatus`                      | measured successful native fixture                                            |
| `connections.listInstitutions`                 | measured successful native fixture                                            |
| `connections.connectInstitution`               | measured successful native fixture                                            |
| `connections.listConnections`                  | measured successful native fixture                                            |
| `connections.getConnection`                    | measured successful native fixture                                            |
| `dashboard.initializeDashboard`                | measured successful native fixture                                            |
| `dashboard.getDashboard`                       | measured successful native fixture                                            |
| `dashboard.getDashboardView`                   | measured successful native fixture                                            |
| `dashboard.listDashboardCatalog`               | measured successful native fixture                                            |
| `dashboard.applyDashboardEdit`                 | measured successful native fixture                                            |
| `emailAuthentication.requestEmailReplacement`  | measured successful native fixture                                            |
| `emailAuthentication.completeEmailReplacement` | measured successful native fixture                                            |
| `transactions.createTransaction`               | measured successful native fixture                                            |
| `transactions.listTransactions`                | measured successful native fixture                                            |
| `transactions.searchTransactions`              | measured successful native fixture                                            |
| `transactions.getTransaction`                  | measured successful native fixture                                            |
| `transactions.linkTransactions`                | measured successful native fixture                                            |
| `transactions.unlinkTransactions`              | measured successful native fixture                                            |
| `transactions.updateTransaction`               | measured successful native fixture                                            |
| `transactions.deleteTransaction`               | measured successful native fixture                                            |
| `transactions.listSourceAttestations`          | declared operation without installed canonical owner; performance unavailable |
| `ingestion.enableEmailForwarding`              | measured successful native fixture                                            |
| `ingestion.getEmailForwarding`                 | measured successful native fixture                                            |
| `ingestion.submitForExtraction`                | measured successful native fixture                                            |
| `ingestion.getStatementSubmission`             | measured successful native fixture                                            |
| `ingestion.listNeedsReviewItems`               | measured successful native fixture                                            |
| `ingestion.resolveNeedsReviewItem`             | measured successful native fixture                                            |
| `ingestion.skipNeedsReviewItem`                | measured successful native fixture                                            |
| `ingestion.abandonStatementSubmission`         | measured successful native fixture                                            |
| `insights.getRecurringDigestReport`            | measured successful native fixture                                            |
| `insights.getReminderSchedule`                 | measured successful native fixture                                            |
| `insights.updateReminderSchedule`              | measured successful native fixture                                            |
| `insights.listPendingInsights`                 | measured successful native fixture                                            |
| `insights.markInsightDelivered`                | measured successful native fixture                                            |
| `insights.markInsightRead`                     | measured successful native fixture                                            |
| `insights.dismissInsight`                      | measured successful native fixture                                            |
| `recurring.listRecurringSeries`                | measured successful native fixture                                            |
| `memory.remember`                              | measured successful native fixture                                            |
| `memory.revise`                                | measured successful native fixture                                            |
| `memory.forget`                                | measured successful native fixture                                            |
| `memory.recall`                                | measured successful native fixture                                            |
| `subscription.getUpgradeUrl`                   | measured successful native fixture                                            |
| `subscription.listSubscriptionOffers`          | measured successful native fixture                                            |
| `subscription.getSubscriptionStatus`           | measured successful native fixture                                            |
| `subscription.cancelSubscription`              | measured successful native fixture                                            |
| `quota.getQuota`                               | measured successful native fixture                                            |
| `pats.listPATs`                                | measured successful native fixture                                            |
| `pats.getPATActivity`                          | measured successful native fixture                                            |
| `pats.revokePAT`                               | measured successful native fixture                                            |
| `pats.revokeAllPATs`                           | measured successful native fixture                                            |
| `pats.createManualPAT`                         | measured successful native fixture                                            |
| `pats.inspectPATPairing`                       | measured successful native fixture                                            |
| `pats.approvePATPairing`                       | measured successful native fixture                                            |
| `recovery.rotateBackupRecoveryCode`            | measured successful native fixture                                            |
| `operations.executeAtomicBatch`                | measured successful native fixture                                            |
