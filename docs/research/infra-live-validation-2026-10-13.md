# Infrastructure assessment: final live validation — 2026-10-13

The account token works. The remaining controlled live history/concurrency measurements completed,
and the compact inline atomic batch passed canonical decoding. The subsequent native Workers AI
model conformance run passed all nine live checks, after 42 deterministic regressions passed.
The schema optimization is deployed through [PR #1281](https://github.com/B4rz99/fidy-ai/pull/1281)
at `4f4995f7a87537c47ee4e4a875a98c9aeb005550`; production run `38447801216` passed release
promotion, smoke checks, topology and drift verification. A direct Cloudflare version read confirmed
100% Core traffic on that revision. No billing plan or approved model was changed.

The [evidence](infra-live-validation-measurements-2026-10-13.json) preserves collection times,
provider usage, native D1 operations, deployment identity and production observations. This completes
the bounded live follow-up to the [infrastructure assessment](infra-capacity-assessment-2026-10-11.md).
It establishes a tested operating envelope; it does not establish production saturation throughput,
a latency SLO, guaranteed peak heap, or complete provider delivery tails.

## Coverage and reconciled changes

| Agreed work                         | Evidence and conclusion                                                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map infrastructure and request flow | Original assessment maps public ingress, private Core/Email, User coordinators, D1, R2, Queues, Workflows, Workers AI and external providers. Architecture and deployed topology checks agree.                                                                                  |
| Baseline foreground and idle work   | Canonical queries/mutations, public browser navigation, full statement processing, asynchronous recovery and separate idle Core/Email measurements are retained in the original assessment; live hosted Turn costs are added below.                                             |
| Workload growth                     | Native cohorts cover History size, Reconciliation density, statements, up to 32 Users, same-User serialization and maintenance backlog/interference. Live AI cohorts now cover 0/8/32 retained Turns and two simultaneous requests. Native and live boundaries remain separate. |
| Capacity and cost                   | Reproducible daily scenario now budgets 48k input tokens per inference, three Turns with four inferences each, and explicit reserves. AI is the first allocation pressure in that scenario; statement-heavy workloads can bind D1 writes or installed admission limits first.   |
| Evidence-based optimization         | Indexed History/Correction and review work, scoped admission, browser assets, idle PAT writes, terminal statement refusals and compact provider schemas are reconciled below. No speculative topology or caching change is justified by these measurements.                     |
| Validate and report                 | Regression/CI/release evidence, successful live model checks, matched provider costs and refreshed production observations are distinguished from observational limits. Earlier failures remain recorded.                                                                       |

Earlier measured gains retain their own workload boundaries: History at 20k linked records
430,002 → 304 reads; Correction 1,304 → 300; 1,024-review work 1,587,487 → 20,252;
status with 5,001 unrelated records 5,025 → 25; mobile navigation median LCP 3,216 → 2,440 ms
in its original matched browser experiment. The later web rewrite has its own navigation cohort.
[PR #1226](https://github.com/B4rz99/fidy-ai/pull/1226), merge revision
`9e9bd72d756b91a3bda3ed9f235f9754e4bf80ca`, deployed the idle PAT assertion and permanent
capture-refusal changes: warm Core maintenance 23 → 21 D1 writes; a 101-row statement retains
100 committed captures and settles its permanent refusal instead of requesting futile retries.
Those changes are ancestors of the currently verified release. Tests and tradeoffs remain in the
original assessment and companion measurement files.

## Completed live hosted Turn cohort

These runs use the actual UserTransactionCoordinator, native local D1, retained Transcript/Turn
state and browser delivery acknowledgment, with real Workers AI REST calls beneath the binding seam.
They do not measure production coordinator CPU, production D1 latency or edge cold starts. Synthetic
history text differs from the earlier baseline, so the two cohorts do not isolate latency gains.

| Seeded retained Turns | Completion, two samples | Input tokens    | D1 reads  | D1 writes |
| --------------------- | ----------------------- | --------------- | --------- | --------- |
| 0                     | 4.738 / 5.236 s         | 41,643 / 41,724 | 86 / 99   | 54 / 51   |
| 8                     | 9.019 / 3.376 s         | 42,211 / 42,292 | 176 / 187 | 51 / 51   |
| 32                    | 1.746 / 1.764 s         | 43,914 / 43,996 | 440 / 451 | 51 / 51   |

The second sample retains the first sample's completed Turn. Costs include browser acknowledgment
and exclude fixture seeding. Greeting Turns used one inference each, without canonical tool execution.
Cache hits varied substantially; faster 32-Turn samples do not establish that longer history is faster.
The six observations are insufficient for a reliable population p95/p99.

Different Users completed concurrently in **4.534 / 1.910 seconds**, with two model calls,
176 D1 reads and 108 writes combined. The same User completed both requests in **1.661 / 4.162
seconds**, with two calls, 185 reads and 105 writes. No pending Turn remained. Earlier baseline
contention returned 202/503 with one call: acknowledgment timing determines whether the next request
can proceed. This is serialization/recovery evidence, not a stable rejection rate or throughput SLO.
Ten successful live inferences used **2,940.308 reported neurons**. Concurrency can consume allocation
more quickly; it does not increase the daily allocation.

## Matched schema cost and compatibility

The deployed compiler removes a duplicate homogeneous array `prefixItems` schema while retaining
`items`, bounds, heterogeneous tuples and annotation data. Canonical decoders, permissions, User
isolation, confirmation and durable recovery remain authoritative. The reference-based alternative
that produced empty atomic batch arguments was discarded; none of its apparent savings are credited.

On the same catalog and fixed synthetic greeting context, changing only provider parameter schemas:

| Measure                          | Original inline | Compact inline |
| -------------------------------- | --------------- | -------------- |
| Full serialized provider request | 184,567 bytes   | 128,874 bytes  |
| Reported input tokens            | 43,523          | 42,375         |
| Output tokens                    | 11              | 11             |
| Cached input tokens              | 1,088           | 20,928         |
| Reported neurons                 | 391.018         | 290.400        |
| Provider response time           | 5.755 s         | 5.928 s        |

The matched **30.2% byte reduction** yields **2.6% fewer reported input tokens**, not a proportional
billing reduction. At the published uncached input rate, 1,148 fewer tokens corresponds to about
**10.437 neurons/inference**. The measured neuron difference also includes different cache hits,
so it cannot all be attributed to this change. No latency improvement was demonstrated by this pair.
The earlier 36.0% figure concerns parameter-schema bytes only, rather than this entire request.

This pair is provider-cost evidence only: the temporary harness omitted the mandatory tool-call
limit, and continuation construction failed after both valid HTTP 200 greeting responses. That
harness error is excluded from adapter correctness evidence. Correctness instead uses the successful
actual coordinator cohort, focused atomic batch decoding and native conformance run.

The focused compact batch produced two correctly decoded synthetic Transaction-create children;
no financial mutations were executed. Earlier native/focused date-only checks failed because the
model returned `2026-09-21T04:00:00Z`, rather than Bogotá midnight `2026-09-21T05:00:00Z`.
The Transaction-create schema is byte-for-byte unchanged. The subsequent full native run passed,
but that pass does not erase the demonstrated semantic variability. Schema validity alone cannot
prove that model-inferred dates match User intent; this remains a correctness limit of the approved
model, independent of the schema compaction.

## Extended production observations

Account GraphQL was refreshed at **18:51 UTC**, covering Oct 12 and the partial Oct 13 UTC day.
The provider telemetry query covers the preceding 24 hours and spans releases/test traffic.

- D1 Oct 12: **607,003 reads / 45,542 writes**; partial Oct 13: **528,857 / 29,769**.
  Partial-day query p50/p95/p99: **0.20 / 0.51 / 0.79 ms** in ENAM. These are query analytics,
  not end-to-end request latency or an idle/foreground attribution.
- Core coordinator sampled memory maxima: **25,150,848 bytes** Oct 12 and **20,770,894 bytes**
  partial Oct 13. Periodic CPU-limit, memory-limit and fatal-internal counters are zero. Invocation
  failures still include nine alarm exceptions Oct 12 and client disconnects; the system is not
  declared error-free. Sampled memory does not expose each Turn's peak heap.
- Core coordinator active-duration accounting: **3,495.065 GB-s** Oct 12 and **2,787.282 GB-s**
  partial Oct 13. These account/runtime observations are separate from local hosted fixtures.
- Operational Workflows: **288 successful steps** Oct 12 and **225** partial Oct 13, with zero
  reported retries in those groups. Available queue-wait groups report p95 approximately
  **1.82–1.87 seconds**; they do not identify product message delay or final delivery.
- Resend: **66 sampled successful provider responses**, p50/p95/p99 **332 / 459 / 2,516 ms**,
  sample interval **1.158**. These are HTTP response timings, not mailbox delivery. No Kapso or
  Wompi product sample was returned. User delivery confirmation tails cannot be inferred from
  these absent samples.
- Maintenance: **1,382 sampled successes and one failure** in the 24-hour telemetry query;
  successful p50/p95/p99 **18.832 / 20.161 / 20.788 seconds**. These spans cross releases and
  are not isolated owner timings; a specific slow owner or foreground interference cannot be
  assigned from the aggregate. Native backlog/interference evidence remains separately recorded.

The retrieved production fields do not identify a cold-start population or per-Turn peak memory.
Version metadata exposes deployment identifiers/revision but did not return `startup_time_ms`.
Thus no cold-start latency distribution is asserted. Request-error aggregates include security and
canary traffic and cannot be relabeled as a User error rate.

## Quota behavior and recommended budgets

The provider recovered around **18:40 UTC**, before the normal 00:00 UTC reset, without a billing or
model change. Earlier 429/error 4006 at approximately 3,986 reported neurons remains unexplained;
it was not established to be exhaustion of the published 10,000-neuron allowance. The final
18:50 analytics snapshot reports **7,957.370 neurons** across all retrieved models/request sources.
Those analytics may lag and do not expose the enforcement counter. Successful calls prove access
and present availability, rather than an enforcement repair or guaranteed remaining allowance.

The [current capacity model](infra-capacity-model-2026-10-13.json) conservatively retains 48,000
input tokens/inference, four inferences/Turn, 250 output tokens/inference and a 2,000-neuron reserve.
Three hosted Turns/day produce approximately **7,318.235 neurons/day** including that reserve.
The 48k allowance covers these measured short-history prompts; longer text/history and tool-heavy
continuations remain separately bounded by installed context/round/spend policy. Four calls and
250 output tokens remain assumptions, not measurements of a tool-heavy Turn.

Recommended daily account planning budgets remain **8,000 AI neurons, 3 million D1 reads,
70,000 D1 writes, 7,000 Queue operations and 2,100 Workflow steps**, plus the original request,
active-duration and storage budgets. The default scenario estimates 1,463,282 reads, 64,840 writes,
5,920 Queue operations and 526 Workflow steps. Local greeting costs fit the explicit D1 admission
reserve in this scenario; reserves are not evidence for every unmeasured workload. Heavy statement
review or retries can consume the remaining write headroom. The fixed canary's 4,320 Queue
operations/day preserves required freshness; changing that freshness is not justified by these data.

No Workers Paid plan is needed to run the bounded parser on its existing Free Durable Object
runtime. The earlier standalone HTTP proof used an incompatible paid CPU configuration. The actual
hosted DO proof succeeded; that restriction was a harness mismatch, not a prerequisite for reducing
cost. Free allocations constrain scale rather than prevent optimization.

Sources: [Workers AI pricing and reset](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[Workers analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/). Provider prices and
invoices are not exposed by these Cloudflare observations; this is resource-demand planning, not
an account invoice reconstruction.

## Validation and remaining limits

PR #1281's full attached CI passed; production deployment passed and the current Core version was
read directly. The latest local deterministic inference checks passed **42 tests**, the native live
model checks passed, and the temporary actual coordinator live cohort passed. Earlier native
retention/isolation/recovery and statement fixture regressions remain recorded with that PR and
the original assessment. Temporary live harnesses were removed; live AI testing remains operator
invoked rather than added back to CI.

The final evidence PR also exposed a browser acceptance probe that assumed immediate canonical
admission while mounted pages and other journeys shared the synthetic User. Real Core returned
`ResourceLimited` (HTTP 429); deliberately exhausting the User's burst reproduced the failure.
The session regression now uses the existing schema-validated, bounded `Retry-After` pacing helper
shared with canonical journeys. It explicitly exhausts the burst and still verifies that stale drafts
and logout cannot alter the current session. Production admission limits are unchanged.

Final CI also exposed a hosted-runner capacity limit: the macOS native store check remained
unassigned for 901 seconds and GitHub cancelled provisioning before any step ran. Its annotations
explicitly reported macOS ARM capacity constraints. All four adapter shards and both browser shards
passed on the same revision. The platform-neutral native store bundle now runs on the supported
`macos-15-intel` pool, retaining Windows coverage and the separate ARM macOS release-package checks.
This changes runner placement, not assertions or timeouts. The earlier adapter attempt's three
OAuth timeouts are retained: the same files passed 80 focused local tests and the CI rerun passed.

Runner source: [GitHub-hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Remaining limits are explicitly measured or unavailable: small live sample counts, changed history
fixtures, no production saturation workload, unresolved early quota enforcement/accounting
behavior, occasional model date semantics, unobserved product delivery tails and cold-start/per-Turn
heap attribution. None is represented as zero latency/cost or universal optimization completion.
The assessment and bounded validation are complete; these observations do not warrant additional
speculative production changes or a paid-plan requirement.
