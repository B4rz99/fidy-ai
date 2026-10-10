# Infrastructure platform capacity reference — 2026-10-10

## Scope and topology

Official Cloudflare documentation checked on 2026-10-10. This is a platform reference, not evidence of the account's actual subscription, deployed revision, traffic, or capacity. Prices are USD. Repository topology reconciled at `2284a6e8a`.

[`alchemy.run.ts`](../../infra/cloudflare/alchemy.run.ts) declares public Ingress → private Core through a service binding, a static Web Worker, private ForwardedEmail Worker, one D1 Database with read replication disabled, one coordination Durable Object class (with a reserved maintenance instance), three R2 buckets, ten queues (including the dead-letter queue), and eight Workflow definitions. Core runs every minute; ForwardedEmail every five minutes: **1,728 scheduled firings/day**, before alarms, retries, canaries, queue consumption, or Users. These counts describe repository configuration, not a remote inventory. Authenticated production inventory confirms the application resources plus Alchemy's state Worker and Store namespace: five Workers and two DO namespaces in total. The [production assessment](infra-performance-production-2026-10-10.md) records actual consumption and subscription discovery; R2 Paid was returned, while Workers Paid was not established.

## Free-plan operating envelope

| Product / scope                 | Published Free allocation or constraint                                                              | Accounting implication                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Workers, account                | 100,000 requests/day; 5 Cron Triggers; 100 Workers                                                   | Shared across the account. Workflow starts also use the requests allocation.                             |
| Workers, invocation / isolate   | HTTP and cron CPU 10 ms; memory 128 MB/isolate; 6 connections awaiting headers per request           | CPU excludes I/O wait. Memory is shared by concurrent requests in an isolate.                            |
| D1, account                     | 5 million reads/day; 100,000 writes/day; 5 GB total storage; 10 databases                            | Every database and maintenance/query/mutation workload competes for the same D1 allowance.               |
| D1, database / invocation       | 500 MB/database; D1 docs list 50 queries/invocation; 30 seconds per query/batch                      | This topology's single database reaches 500 MB before the 5 GB account ceiling.                          |
| SQLite Durable Objects, account | 100,000 requests/day; 13,000 GB-s/day; 5 million SQL reads/day; 100,000 SQL writes/day; 5 GB storage | Model DO compute and SQL separately from D1; matching allowances do not establish one shared D1/DO pool. |
| Durable Objects, object         | CPU 30 seconds by default; 10 GB/object, subject to smaller Free account cap                         | Moving maintenance changes its CPU envelope but retains its D1 demand.                                   |
| Queues, plan                    | 10,000 operations/day; retention fixed at 24 hours                                                   | Successful small messages usually consume three operations; roughly 3,333/day before retries.            |
| Workflows, account              | 3,000 steps/day; 100 running instances; 1 GB-month storage                                           | Workflow definitions do not each receive their own allocation.                                           |
| Workflows, instance             | 1,024 steps; 100 MB persisted state; 1 MiB non-stream result; completed state retained 3 days        | Completed/errored/sleeping state still consumes storage.                                                 |
| Workers AI, allocation          | 10,000 neurons/day                                                                                   | All inference must be included, including repeated tool continuations and other AI consumers.            |
| R2 Standard, monthly allocation | 10 GB-month; 1 million Class A operations; 10 million Class B operations                             | Aggregate buckets in the model; Standard free usage does not apply to Infrequent Access.                 |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/), [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/), [AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

## Measurement and workload formulas

### Workers

Count external dynamic requests and Workflow starts; count static asset requests separately because they are free. Avoid treating Ingress → Core as a second external billed request: [service bindings add no request cost](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/). Measure CPU across the chain. Service-bound Workers share the six-connection limit. CPU and end-to-end latency require separate distributions; local elapsed time is not production CPU evidence. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### D1

Use actual `meta.rows_read` and `meta.rows_written`, not returned records or affected entities. Reads include scanned rows; INSERT/UPDATE/DELETE and index maintenance consume writes; tables and indexes consume storage. Free daily usage resets at 00:00 UTC (19:00 previous calendar day in Bogotá). Exceeding daily read/write limits blocks queries. [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)

For workload classes `i`, `dailyReads = maintenanceReads + Σ(actions_i × reads_i)` and similarly for writes. Budget headroom must also cover other account databases. For the single primary, approximate service utilization as `Σ(arrivalRate_i × databaseExecutionSeconds_i)`; near one, queueing dominates. Each D1 database processes queries sequentially and returns overload errors when its queue fills. This utilization formula is a modeling approximation, not a promised throughput SLA. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)

### Durable Objects

Approximate `GB-s = 0.128 × Σ(active wall seconds per object)`, following Cloudflare's examples. Overlapping requests within one object share active duration; separate objects each accrue it. Pending I/O can hold an object active. Each top-level stub RPC session and alarm counts as a request; `setAlarm()` writes one SQL row. Storage key/value calls also use SQLite row accounting. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

### Queues

For messages delivered successfully: `operations ≈ Σ(ceil((payloadBytes + metadataBytes)/64000) × (3 + retries))`; metadata is approximately 100 bytes. Dead-letter handling adds operations, so measure it separately. Batching reduces consumer invocations, not per-message operations. [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)

Maximum message size is 128 KB; maximum batch 100; per-queue throughput 5,000 messages/s; push consumer concurrency up to 250; wall-time limit 15 minutes. These ceilings are not sustainable Free daily capacity. Backlog must clear inside 24-hour Free retention. [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)

### Workflows

Use `dailySteps = Σ(instances_i × executedSteps_i)`. Retry attempts do not add billed steps, but still consume execution resources and external operations. Sleeping and I/O wait consume no CPU. Requests share Workers pricing; retained instance state is charged independently. Step/storage billing began August 10, 2026, so older estimates omitting them are stale. [Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)

Waiting instances do not consume running concurrency. The docs call Free CPU both 10 ms per step and 10 ms per invocation; record both and verify the execution boundary through production outcomes before relying on step splitting. The limits page also has stale prose referring to 10,000 concurrency while its table says Free 100 / Paid 50,000. Use the plan-specific table for planning. [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)

### Workers AI

The repository approves `@cf/google/gemma-4-26b-a4b-it` in [`contract.ts`](../../apps/server/src/shell/hosted-inference/contract.ts). Published pricing yields `neurons ≈ 9091 × inputTokens/1e6 + 27273 × outputTokens/1e6`. A hypothetical inference using 10,000 input and 1,000 output tokens consumes about 118.2 neurons; 10,000 daily neurons support about 84 such inferences, not 84 Turns if Turns invoke the model repeatedly. Paid excess costs `$0.011 × max(0, dailyNeurons − 10000)/1000`. [AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

Text-generation default rate is 300 requests/minute; some models differ. Local Wrangler model inference still consumes remote allowance. Use returned token/usage data and account usage rather than prompt-character estimates. [AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)

### R2

Estimate storage from average daily peak bytes, including retention and staging overlap. Class A includes puts/lists/multipart operations; Class B includes gets/heads; deletes are free. Standard excess rates: $0.015/GB-month, $4.50/million A, $0.36/million B. Egress is free; billable units round upward. [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Paid-plan comparison and unresolved evidence

Workers Paid starts at $5/account/month. Its shared monthly inclusion is 10 million requests and 30 million CPU ms; excess rates are $0.30/million requests and $0.02/million CPU ms. Upgrade modeling must retain D1/DO/Queues/AI/R2/Workflow storage and steps as separate dimensions, rather than assume the subscription makes them unlimited. [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)

No subscription upgrade, remote resource mutation, or production load test was performed. The public docs contain conflicting Paid CPU statements across Workers pricing, Workers limits, and Queues limits; this reference uses explicit Free values and avoids committing to the disputed Paid cron/queue maximum. Actual account settings, deployed code, observed CPU, database size, resource usage, service-provider latency/rate limits, and regional round-trip latency remain necessary to establish fidy-ai's operating capacity.

## Published-limit inconsistencies to verify against the account

D1's limits page lists 50 queries per Free Worker invocation and 1,000 on Paid, while the current
Workers limits page distinguishes 50 Free external subrequests from 1,000 Free internal-service
subrequests and 10,000 Paid subrequests. Do not use that discrepancy to claim an invocation fits or
fails a hosted plan; verify native execution, batching and the account's configured limits. The
entire D1 batch shares the 30-second duration ceiling. Worker startup has a separate one-second
limit; the current Worker size page specifies 64 MiB uncompressed and no compressed-size limit.

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
