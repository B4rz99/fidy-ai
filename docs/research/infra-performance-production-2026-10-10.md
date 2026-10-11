# Production infrastructure performance — 2026-10-10

## Result and collection boundary

The read-only token successfully accessed Cloudflare resource metadata, GraphQL analytics and
Workers Logs calculation queries. Authentication is no longer a blocker. The completed comparison
window is **October 3–9 UTC**, with an additional October 10 partial window ending **23:30:23 UTC**.
Provider calculations end at 23:35:42 UTC. These are observations of development traffic, release
checks and canaries; they do not establish capacity for a representative User workload.

The [sanitized production artifact](infra-performance-production-2026-10-10.json) retains daily and
hourly resource aggregates, outcomes, queue snapshots, Workflow statuses, operation/provider timings
and deployment artifact measurements. No request contents, headers, financial facts, SQL text or
bindings were retrieved for this assessment. Telemetry requests used `dry: true` and the calculations
view; adaptive results are estimates. None of the queried GraphQL datasets reached its 10,000-row
limit. The telemetry API shortened the requested eight-day window to its available seven-day window;
its effective timestamps and sampling intervals are preserved rather than implying complete retention.

The actual account contains five Workers, one D1 database, two Durable Object namespaces, ten Queues
with nine consumers, eight Workflows and three R2 buckets. Alchemy's state Worker and Store namespace
are deployment infrastructure and must be separated from the application's coordinator.

Subscriptions returned R2 Paid, the zone Free plan and Teams Free Base. **No Workers Paid subscription
was returned.** Worker settings report `usage_model: standard`; that field alone cannot prove the
subscription. Comparisons with Workers/D1 Free allocations below are conditional. R2 Paid does not
establish Workers Paid. No subscription, release or other account state was changed.

## D1: resource consumption is the primary demonstrated growth constraint

The database reports **5,935,104 bytes (5.66 MiB)**. Storage is currently small, while reads have been
material even without representative product traffic.

| UTC day   | Rows read | Rows written | Batch p95 ms | Batch p99 ms |
| --------- | --------: | -----------: | -----------: | -----------: |
| October 3 |   138,754 |       11,077 |         0.60 |         1.85 |
| October 4 |   195,717 |       16,525 |         0.62 |         1.82 |
| October 5 |   101,715 |        6,598 |         0.61 |         1.68 |
| October 6 |   220,539 |       14,139 |         0.82 |         1.93 |
| October 7 | 1,672,933 |       50,438 |         1.19 |         2.08 |
| October 8 | 2,914,770 |       14,317 |         0.99 |         2.07 |
| October 9 | 5,442,187 |       22,808 |         0.90 |         1.80 |

October 9's reported reads exceed the published five-million Free daily allocation by 8.8%.
Adaptive counts and subscription ambiguity prevent treating this alone as proof of hard-quota
exhaustion. Low database duration does not make the row budget safe. The earlier retention incident
and subsequent indexed sweeps explain why maintenance required attention; daily aggregates cannot
attribute every row to that cause or to the new local candidate.

The candidate removes unused search-index write work, whole-history sorting for ready projection
History pages, and quadratic pending-review admission scans. Its measured reductions remain local:
**92.3% Capture reads / 77.0% Correction reads** at valid long Notes; **99.93% linked History reads**
at 20,000 Transactions; **98.7% complete review-processing reads** at 1,024 statement rows. These
changes were not present in the downloaded production release, so no production reduction is credited.

The October 10 partial window reports 305,941 reads and 29,289 writes. Its earlier cron failures
mean this lower read total is not a healthy-maintenance capacity baseline.

Production per-query duration/row aggregates were collected without selecting query text. This
account's D1 query dataset offers a query-text dimension rather than a hash dimension. Attribution
to individual statements remains a gap; this report deliberately retains resource-level aggregates.

## Workers and maintenance: historical failures, recent improvement

Core reports **6,583 exceededResources invocations** in the completed seven-day window. October 9
has 666 in adaptive analytics; the scheduled-event dataset separately reports 671 resource failures
and 116 exceptions. These datasets have different aggregation semantics and should not be forced to
reconcile. Email's October 9 schedule also reports 84 exceptions; the current partial day reports
288 successful schedule events and no exceptions.

Observed Core cron CPU tails and outcomes around the recent maintenance relocation:

| October 10 UTC hour | Events | Successful | Resource failures | Exceptions | CPU p50 / p95 ms |
| ------------------- | -----: | ---------: | ----------------: | ---------: | ---------------: |
| 18:00               |     60 |         54 |                 6 |          0 |   75.47 / 198.79 |
| 19:00               |     60 |         34 |                26 |          0 |    59.13 / 92.57 |
| 20:00               |     61 |         57 |                 3 |          1 |      1.46 / 7.97 |
| 21:00               |     60 |         60 |                 0 |          0 |      1.33 / 2.79 |
| 22:00               |     60 |         60 |                 0 |          0 |      1.30 / 2.71 |
| 23:00, partial      |     28 |         28 |                 0 |          0 |      1.11 / 2.27 |

The last three observed hours have no platform Worker errors. This is evidence consistent with
moving maintenance into the private Durable Object, not proof of sustained recovery under load.
The actual completed maintenance work still takes time: the latest release's ten completed-work
observations show **17,966 ms p50 / 18,365 ms p95** elapsed time. Its scheduled wrapper shows
18,142 / 19,000 ms. Wall time includes I/O; it is not cron CPU. The coordinator's native idle tick
still consumes D1 reads/writes, so the relocation solves a CPU boundary without erasing database cost.

On October 9, successful Core invocations report CPU p50 **4.459 ms**, p99 **87.459 ms**; successful
Ingress p50 **2.472 ms**, p99 **15.611 ms**; successful Email p50 **3.858 ms**, p99 **12.213 ms**.
Worker GraphQL CPU and wall quantiles are microseconds and were converted to milliseconds here.
Do not apply HTTP's CPU envelope to combined HTTP, Workflow, Queue and other invocation families.

## Durable Objects: a real historical memory incident remains unexplained

The **application** coordinator namespace recorded **two exceededMemoryErrors on October 7,
20:00 UTC**, with a namespace maximum of **150,849,741 bytes**. Later dates show roughly 16–18 MB
and no further memory-limit errors in the completed window. The namespace aggregate does not identify
the hot User, method or request responsible; the maximum is not a per-request memory allocation.
Alchemy's Store is a separate namespace and did not record this incident.

The error counter confirms a memory problem occurred. A local retained-heap XLSX measurement is not
peak isolate memory and cannot explain it. Raising concurrency is therefore unjustified until peak
memory and coordinator contention are measured with a representative isolated workload. Existing
metadata does not support a specific corrective code change for the historical incident.

## Queues and Workflows: monitoring dominates observed activity

October 9 OperationalCanary operations include **775 writes, 1,120 reads, 662 successful deletes and
115 deletes to DLQ**. Reads exceeding writes demonstrate retries in the observed window; message
origination can span day boundaries. ReleaseSmoke recorded 72 writes, reads and successful deletes.
Other product queues had no operations in the completed window. This provides canary behavior rather
than billing, statement or email recovery capacity.

At 23:30:23 UTC all nine consumed queues reported zero backlog. The shared dead-letter queue reports
**114 messages / 4,332 bytes**, with oldest timestamp **October 9, 16:57:56 UTC**. That timestamp is
older than its configured 24-hour retention. Treat the metric as a possible stale snapshot or delayed
expiry until verified; it is not proof of a retention defect. No messages were pulled, acknowledged,
replayed or deleted. Historical canary failures are consistent with the earlier Worker failures;
resource aggregates cannot prove every dead letter's precise cause.

Only OperationalCanary and ReleaseSmoke appear in the completed Workflow analytics. Their current
inventory shows 356 and 220 complete instances respectively, with no running/queued/errored instances;
these inventory counts span retained state rather than the seven-day analytics window. The six other
Workflow definitions report zero instances. No blocked-reason records were returned. START, RUNNING
and SUCCESS records are lifecycle events, not three independent instances; do not add their counts.
Hosted statement parsing and its overlap envelope remain unobserved.

The local configured canary baseline is 4,320 Queue operations/day before retry amplification.
Five-minute Workflow identity deduplication does not deduplicate minute-by-minute Queue offers.
Any cadence/offer change must retain failure recovery and the intended stale-health detection window;
reducing it without those requirements would weaken monitoring. Existing production evidence does
not establish that monitoring can safely be less frequent.

## Providers, AI, R2 and Web assets

Metadata-only completed-work calculations over the latest 24 hours returned:

| Operation/provider    | Outcome   | Estimated count | Sample interval | Elapsed p50 / p95 / p99 ms |
| --------------------- | --------- | --------------: | --------------: | -------------------------: |
| Workers AI model work | succeeded |              18 |               1 |      1,488 / 7,966 / 7,966 |
| Resend request        | succeeded |              61 |               1 |            319 / 563 / 943 |
| Kapso request         | succeeded |               4 |               1 |        117 / 1,396 / 1,396 |
| Kapso request         | rejected  |               1 |               1 |            152 / 152 / 152 |

Small populations cannot establish stable provider p99 or throughput. The longer telemetry query
was sampled at intervals around 10; its estimated counts are not raw sample sizes. These are elapsed
completed-work timings, not CPU, and exclude operations that terminate before exporting completion.
No comparable production Google, Microsoft or payment-provider timing population was returned.
Generic fetch/queue outcomes include release probes and rejection paths and cannot be equated to
User errors. The latest-release generic Core fetch succeeded p95 is 771 ms across 125 estimated
observations; this does not label all 68 canonical API operations.

Workers AI reports 110 calls and **975.036 neurons** on October 9, its highest completed-day count:
9.75% of the published 10,000-neuron daily allocation. All returned inference error codes are zero.
The model is `@cf/google/gemma-4-26b-a4b-it`. Observed inference cost is about 8.86 neurons/call that
day; a heavier hypothetical multi-call Turn must not be substituted for the observed distribution.
Calls are not equivalent to Turns.

The statement staging and forwarded-email buckets report zero stored objects in the completed
window; the smoke bucket reports one object with eight payload bytes. The seven-day R2 operation dataset reports 1,924 requests and no 5xx responses. Operation aggregates
and storage maxima are in the artifact. This is insufficient for accepted-document storage forecasts.
R2 Paid is enabled even though measured storage is negligible.

Worker asset analytics report **8,268 HIT / 178 MISS requests**: a 97.89% hit share among classified
HIT/MISS requests. Redirects and method rejections have no cache classification and are excluded
from that denominator. This is account-level asset traffic; it does not measure browser Web Vitals,
regional application latency or authenticated API caching.

## Actual deployed artifact startup

The production release observed at 23:24 UTC is `d8be4d7ea701d063d23f2b57ecb2cf0f63f0eff7`, newer than
this candidate's pinned `2284a6e8a` baseline. The actual Public/Core/Email modules were downloaded
read-only and profiled locally with their deployed compatibility date `2026-09-08` and flag
`new_module_registry`. No environment variable values or resource bindings were copied into the
reconstructed profile metadata.

| Actual module | JavaScript bytes | Local active startup ms | GC included ms |
| ------------- | ---------------: | ----------------------: | -------------: |
| Public        |          484,889 |                    82.7 |            3.8 |
| Core          |        2,816,143 |                   192.3 |            9.4 |
| Email         |        1,251,037 |                   111.4 |            7.4 |

Source maps are excluded from executable size. These profiles close the artifact-identity gap of the
previous standalone Alchemy builds; CPU remains local and does not establish Cloudflare's hosted
startup duration. Successful promotion provides deployment-validation evidence, while the API did
not expose a hosted startup timing. No startup-specific code change is justified by these samples.

## Remaining work that needs a release or a representative workload

The read-only assessment and tested local optimization candidate are complete. Production validation
of the three changes requires merging/releasing the candidate and observing the deployed revision.
The token cannot perform that release. A representative isolated write workload is also required to
establish mixed User capacity, all-operation CPU tails, hot-User serialization, worst-case search,
peak memory, document parsing, queue recovery and provider failure behavior. None can be established
from idle development/CI traffic, even with complete read permissions. Performance/error targets
must be set before translating those measurements into a supported traffic envelope.

Primary references: [GraphQL Worker analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/),
[settings and entitlements discovery](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/),
[D1 metrics](https://developers.cloudflare.com/d1/observability/metrics-analytics/),
[Workers Logs queries](https://developers.cloudflare.com/workers/observability/query-builder/),
[read-only telemetry calculation API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/),
[Worker content download API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/),
[platform limits](https://developers.cloudflare.com/workers/platform/limits/).
