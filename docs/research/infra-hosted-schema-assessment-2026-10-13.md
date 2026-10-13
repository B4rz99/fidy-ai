# Hosted inference cost follow-up — 2026-10-13

## Outcome and boundary

The new account token successfully authenticated the native Wrangler remote AI session, model catalog,
and analytics. Original inline schemas passed native model conformance and a live two-child atomic
batch decoding control. Access is no longer the blocker. Renewed provider HTTP 429/error 4006
prevents completion of the live optimized cohort. This follow-up does not claim the full infrastructure
assessment is finished.

[Evidence](infra-hosted-schema-measurements-2026-10-13.json) separates successful baseline calls from
an offline schema comparison. The baseline runs the actual UserTransactionCoordinator with native
local D1, retained hosted Turns and browser acknowledgments, using live Workers AI REST beneath the
binding seam. Coordinator CPU, D1 timings, memory and cold starts are not production edge measurements.
Baseline revision: `1f8a7073`; equivalent-schema comparison uses catalog revision `3d9f8b426`.

## Live baseline

| Retained history | Samples | Completion times      | Input token range |
| ---------------- | ------- | --------------------- | ----------------- |
| 0 Turns          | 2       | 6.216 / 6.720 seconds | 42,792–42,883     |
| 8 Turns          | 2       | 5.383 / 2.019 seconds | 44,040–44,135     |
| 32 Turns         | 2       | 2.277 / 5.915 seconds | 47,806–47,902     |

Two different Users completed concurrently in 2.612 / 1.988 seconds. Two requests for the same User
returned 202 / 503; only one inference ran, and no pending Turn remained. This short burst captures
contention and acknowledgment timing; it does not establish throughput or a stable rejection rate.
Nine successful baseline inferences used 2,598.863 reported neurons. Each completed greeting needed
one inference, without tool execution. Cache usage differed across calls, so these small samples do
not isolate history latency or support p95/p99 claims.

## Measured contributor and focused change

The original empty-history request was approximately 180 KB. The atomic batch schema repeats the
entire child operation union in both the first array position and remaining array positions. This
inflates every request advertising that tool, before any User history is added.

The provider schema compiler now compacts an identical one-element `prefixItems` / `items` pair
into `items`, retaining `minItems` and `maxItems`. It keeps heterogeneous tuples, literal data and
annotations. The canonical Effect input decoder, operation permissions, User isolation and durable
recovery still enforce correctness. The transformation uses inline schemas.

On the **same catalog revision**, provider parameter schemas total **156,542 → 100,167 bytes**
(36.0% reduction); the atomic batch parameters are **106,456 → 51,712 bytes** (51.4% reduction).
The captured full candidate request was 124,057 bytes, compared with the earlier approximately
180 KB baseline. Those are serialization measurements, not token, neuron or latency gains.

A reference-based alternative reduced bytes further but produced empty atomic batch arguments twice;
the original inline control succeeded. That alternative was discarded. Its apparent token and latency
improvements are excluded from accepted evidence. The compact inline candidate has not yet passed
live batch/model verification because inference was refused before output.

## Revised free-allocation planning

The previous calculator assumed 20,000 input tokens/inference. The live baseline already exceeds
that at empty history, so it understated AI demand. The calculator now uses **48,000 input tokens**,
rounded above the observed 32-Turn baseline, with the existing conservative assumptions of four
inferences/Turn, 250 output tokens/inference and a 2,000-neuron daily reserve. The default workload is
**three hosted Turns/day**, giving approximately **7,318 neurons/day** including the reserve. The old
seven-Turn scenario would require approximately **14,409 neurons/day** with these assumptions.

These are scenario budgets, not newly installed admission limits. Longer histories, repeated tool
rounds, output growth and non-Turn AI workloads can require more. The compact schema receives no
modeled token savings until live measurement. Cloudflare documents 10,000 free neurons/day and a
00:00 UTC reset (19:00 Bogotá), but a runtime refusal overrides apparent analytics headroom.
[Official pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

## Renewed quota refusal

At 18:00 UTC, GraphQL reported **3,986.135 neurons** in the retrieved daily inference groups. The
provider nevertheless returned 429/error 4006, including for an eight-token minimal probe. Last
probe request ID: `1ea8191e-2035-4044-bfdf-f3aa99df4512`. Token authentication and successful earlier
calls rule out the previous access failure. The telemetry does not establish ordinary exhaustion of
10,000 neurons, and the account enforcement counter is not exposed by this evidence. Accounting
lag or a provider enforcement inconsistency remain hypotheses. Live requests stopped after the
minimal diagnostic rather than repeatedly retrying.

## Validation and unfinished work

Focused inference regressions cover schema constraints, heterogeneous tuples, annotation preservation,
all canonical tool schemas, malformed responses and recovery. Native hosted Turn/retention checks
exercise acknowledgment, contention, isolation and durable replay. CI verifies the merged revision;
release evidence must be recorded separately from model verification.

After successful inference resumes: first validate the compact inline atomic batch and native
model conformance; then repeat matched 0/8/32-history and concurrency cohorts with explicit call and
neuron limits. Compare actual tokens, neurons, completion and D1 operations; do not infer savings
from bytes alone. Expand cohorts only with remaining quota. Production cold-start attribution and
peak per-User heap remain unobservable in the currently retrieved Cloudflare fields. Previously
recorded sampled DO memory, provider timings and maintenance failures retain their stated boundaries
in the dated infrastructure assessment; this change does not turn them into complete production
coverage.
