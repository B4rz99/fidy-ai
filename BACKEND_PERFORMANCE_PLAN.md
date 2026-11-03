# Cache-free backend performance plan

Local execution checklist requested by the User. This records the approved direction and remaining
work; it is not a claim that the redesign has been implemented. GitHub issues
[#1589](https://github.com/B4rz99/fidy-ai/issues/1589) and
[#1819](https://github.com/B4rz99/fidy-ai/issues/1819) retain implementation and performance evidence.
Keep raw measurements in ignored test results and link the relevant issue or PR here.

## Objective and completion rule

Redesign the cold data path using data-oriented principles, starting with Budget and then applying
the verified approach to Recurring and Dashboard. Remove application data caches and speculative
data preparation rather than using them to satisfy the latency target.

The target is **6.94 ms backend elapsed time**, including server-side waiting, storage I/O,
authorization, accounting and response construction. CPU time alone is insufficient. Browser
network travel and UI rendering must be measured separately. Existing canonical timing headers
cover part of the server path; do not present that subset as complete ingress-to-response time.

Completion requires median and p95 at or below the target for the declared workloads, with correct
results and all verification gates passing. No item is complete merely because a prototype exists,
a single sample is fast, or an optimization improves a smaller component. Keep unmet items open.

## 1. Establish the measurement contract

- [x] Save the approved plan and checklist locally.
- [ ] Declare the supported Budget, Recurring and Dashboard workloads before changing code:
      representative and boundary-size data, response size, concurrency, execution location,
      sample counts and exact source revision.
- [ ] Create an unattended, bounded measurement command that fails when the target is missed.
- [ ] Establish fresh-data baselines for all three workloads without response reuse or prefetching.
- [ ] Separate ingress overhead, admission, coordinator waiting/dispatch, owner work, storage calls,
      final authority/accounting, serialization and browser round-trip time. Identify nested timings
      so they are not added twice.
- [ ] Record median, p95, ranges, failures, storage-call counts and rows read/written. Retain every
      predeclared sample; do not discard first requests or rerun selectively for a favorable result.
- [ ] Distinguish first invocation after startup from later invocations. Fresh application data must
      be read in both cases; a warmed process is not proof of first-use performance.
- [ ] Verify timing precision against the deployed runtime. Workers timers do not advance during
      CPU-only work, so use appropriate profiling for CPU attribution.
- [ ] Keep diagnostics metadata-only: no credentials, User identifiers, financial facts, query
      parameters, request bodies or response bodies in logs or published measurements.

## 2. Inventory and remove application caches

- [ ] Inventory application-defined caches across the server and browser. For each, record owner,
      retained contents, lifetime, consumers and the replacement required for correctness.
- [ ] Remove reusable API-response caches, retained query results used across navigation,
      speculative data preparation and application-level memoized data results.
- [ ] Preserve unsaved forms, drafts and in-flight mutation/recovery state. They represent User
      work and uncertain outcomes, not reusable query responses.
- [ ] Distinguish authoritative records, database indexes and durable domain facts from disposable
      response copies. Do not relabel a new response cache as a projection or read model.
- [ ] Do not add cached monthly Budget responses, duplicated response tables, cross-request data
      memoization or a stale-data fallback to make benchmarks pass.
- [ ] Replace tests that require cached responses with tests proving fresh reads and correct
      request ownership. Preserve meaningful responsiveness checks and failure coverage.
- [ ] Verify that navigation and refresh do not expose data from a retired authentication lifetime.

## 3. Redesign Budget around one month's required output

Conceptual flow:

```text
User + selected month + time zone
  derive month boundaries once
  coordinated storage work
    live authority and admission
    complete planned caps and month-plan existence
    effective Transaction spending for the same period
    required Audit, accounting and final disclosure checks
  bounded assembly pass
    match Category + Currency
    calculate Budget status and remaining Money
    accumulate cash flow by Currency
    identify unbudgeted outflows
  validate and encode one complete response
```

- [x] Trace the real Budget path and identify every storage call, repeated decode and collection
      traversal. Establish a failing regression before changing the identified behavior.
- [x] Derive the applied month and half-open UTC bounds once, preserving the explicit IANA zone.
- [x] Read the complete planned-cap information once where semantics permit. Preserve the distinct
      active-cap and editing-metadata selections; do not simply delete the second read.
- [x] Read month-plan existence alongside compatible cap reads rather than in a separate trip.
- [x] Use the Transaction owner's published effective-fact interface, with bounded indexed reads.
      Preserve Corrections, Reconciliation and incomplete/corrupt-data refusal.
- [x] Use narrow rows containing the required identities, Currency, exact values and revisions;
      avoid building and repeatedly decoding intermediate object graphs.
- [x] Replace per-Budget aggregate searches and repeated totals/membership scans with a bounded
      join/merge and assembly pass. Request-local working structures must not survive the request.
- [x] Preserve exact Money arithmetic. Do not introduce floating-point SQL totals, unsafe integer
      conversions, cross-Currency sums or silent overflow.
- [x] Preserve inherited monthly plans, historical group Currency, filtering, unbudgeted spending,
      cash flow, ordering and complete editing metadata.
- [x] Batch compatible storage work within the existing ownership interfaces. Preserve live
      Consent, exact credential checks, resource admission, Audit and recovery fencing.
- [x] Compare complete before/after responses and work counts on the declared workloads.

## 4. Remove the compute-to-storage latency floor

- [ ] Measure the batched Budget candidate to determine whether remote storage still prevents
      6.94 ms backend elapsed time.
- [ ] If necessary, prototype authoritative per-User SQLite storage and execution inside the User
      coordinator. This must change data ownership rather than retain a cached copy of D1 results.
- [ ] Compare the prototype against the same complete authorized workload, including request
      dispatch, persistence confirmation and response construction; do not benchmark SQL alone.
- [ ] Prove session revocation, Consent withdrawal, admission, concurrent writes, Audit, recovery
      fencing, erasure and interruption behavior under the proposed storage ownership.
- [ ] Before adopting colocation, record the architecture decision and implement the required
      migration, backup/restore verification, cutover and operational recovery procedures.
- [ ] Recheck resource limits and the existing infrastructure budget. Do not silently upgrade the
      account or create unbounded production experiments.

## 5. Apply the proven design to Recurring and Dashboard

- [ ] Apply measured read-shape, locality and batching improvements to Recurring without changing
      occurrence, tracking, fulfillment, filtering or exact financial semantics.
- [ ] Apply them to Dashboard without off-route initialization, partial totals or loss of revision
      consistency across its Widgets.
- [ ] Remove remaining application data-cache dependencies in these paths and their callers.
- [ ] Verify fresh reads reflect committed changes, including changes from another client.
- [ ] Measure complete backend elapsed time for every declared workload and identify any remaining
      repeated reads, allocation/decoding work, queueing or remote storage floor.

## 6. Verify, release and close the checklist

- [ ] Pass complete response-parity tests and security/financial/recovery regression checks.
- [ ] Pass appropriate unit, native integration, browser, architecture, lint and type checks.
- [ ] Update durable architecture and operating procedures to match the final implementation.
      Keep dated benchmark reports with the issue/PR and raw results out of tracked documentation.
- [ ] Deliver incremental reviewed PRs through the required all-check CI gate and squash merges.
- [ ] Verify successful production rollout and matching app/API release revision and contract digest.
- [ ] Run the predeclared bounded production comparison without cached responses or discarded samples.
- [ ] Demonstrate backend **median and p95 <= 6.94 ms** for Budget, Recurring and Dashboard across
      the declared workloads, reporting startup cohorts separately.
- [ ] Report browser round-trip and UI-render timings separately from backend elapsed time.
- [ ] Confirm no application data cache or speculative data preparation remains in the completed
      scope; remove temporary instrumentation and unused experiments.
- [ ] Attach reproducible evidence for every completed requirement. Leave any unmet requirement
      unchecked and state its measured cause; do not declare the whole plan complete prematurely.

## Primary references

- [D1 transactional batching](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Compute and storage colocation](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers timing limitations](https://developers.cloudflare.com/workers/runtime-apis/performance/)

## Execution status

Budget snapshot assembly, code-only navigation preparation and linear Recurring match selection
shipped in [PR #1827](https://github.com/B4rz99/fidy-ai/pull/1827). The native-D1 Budget regression
reduced public-request database trips from eight to five. A concurrent cap mutation test verifies
one coherent response and a fresh subsequent request. Measurements and release evidence belong
to that PR. The complete backend latency target and application-cache removal remain open.

Actual Recurring return visits must refresh canonical state even when they occur within five
seconds or the browser clock is fixed or moves backwards. This removes a freshness exemption.
Dashboard view, catalog and Budget configuration responses now have mounted-consumer lifetimes, with no idle response retention; its
unused data-preparation publication is removed. Remaining hidden query displays and shared
metadata retention are still open. Preserve the separate draft and uncertain-write owners when replacing those displays.

Budget comparison protocol: empty (no caps or movements), typical (one current cap and one exact
80.01 outflow), boundary (128 caps and 5,002 movements). Each cohort performs 21 sequential public
GETs, consumes and validates complete responses, and records every elapsed sample, response byte
count, normalized complete-response digest, storage trips and rows read/written. Fixed time is
2026-11-03T12:00:00Z. Only the randomly generated primary Budget identity is normalized for parity.
The source comparison order is baseline/candidate/candidate/baseline, with no concurrent benchmark
or verification processes. First request is retained and reported separately. This is a local
public-handler/native-D1 measurement with a test coordinator adapter, not native Worker startup or
production ingress timing. The opt-in benchmark enforces the unchanged 6.94 ms median/p95 target;
failures remain evidence. Raw logs live under `/tmp/fidy-budget-*`, outside tracked documentation.
The earlier exploratory candidate run is retained separately and is not part of this comparison.
Production and full-runtime measurement requirements remain open.

### Application response retention inventory (removal in progress)

| Owner                                                          | Retained contents / lifetime                                           | Consumers                                                  | Required replacement                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `transport/workspace-query.ts`                                 | API results, five-minute idle TTL and five-second SWR freshness        | Profile, taxonomy, Budget, Recurring, Transactions, Access | Visit-owned reads with no inactive result retention; preserve mounted editing owners |
| `app/destination-preload.tsx`, `app/navigation-preparation.ts` | Speculatively populated query results, authentication lifetime         | Idle queue and pointer/focus/touch navigation              | Code-only preparation; destination visit owns data reads                             |
| `app/recurring-workspace.tsx`, `app/review-workspace.tsx`      | Hidden visited DOM/query subscriptions until authentication retirement | Recurring/Review return navigation                         | Separate unsaved draft/recovery owners from disposable query displays                |
| `features/dashboard/query.ts`                                  | Dashboard response: no idle retention (active consumers only)          | Dashboard visits                                           | Mounted read, initialization on actual visit only                                    |
| `transport/workspace-query.ts` bootstrap metadata              | Initial identity/taxonomy observation, 400 ms idle handoff             | Initial route and metadata query                           | Bounded initial handoff; never reusable navigation data                              |
| `cloudflare/mcp/runtime.ts`                                    | Scope-keyed generated tool catalog, process lifetime                   | MCP tool listing                                           | Generate from installed declarations without a reusable projection map               |
| `transport/money.ts`, `needs-review/model.ts`                  | Intl formatter instances, process lifetime                             | Financial/date presentation                                | Inventory separately from API data; no User facts are stored                         |

Request-local joins, authoritative database records/indexes, admission semaphores and unsaved
form/recovery state are not reusable query-response copies. The inventory remains open until the
remaining application sources and framework retention defaults have been verified.

The original A/B/B/A Budget cohorts remain retained as diagnostic evidence. Following the upstream
synchronization, a second full A/B/B/A comparison uses baseline `604d999a03` and runtime candidate
`2bd4b30052`, with the identical workloads, sample counts, fixed time, ordering and parity rules above.
Every new sample and target failure is retained separately under `/tmp/fidy-budget-aligned-*`.
Automatic destination data preparation has been removed locally and verified across connection
policies; reusable query retention is still open. Recurring ambiguity selection now uses linear
request-local counting; its complete request and startup measurement requirements remain open.
