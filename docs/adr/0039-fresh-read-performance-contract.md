# Fresh reads determine performance acceptance

- **Status:** Accepted performance direction, ordinary-read budgets and initial workload envelope.

The web application takes seconds to reveal information. Backend redesign will focus on actual
access patterns, bounded set-based work, compact projections and reducing data movement and
sequential round trips. Cloudflare Workers, D1 and per-User Durable Objects remain the initial
platform; replacing them requires evidence of a limiting constraint. Web request composition and
canonical query contracts may change. Live authorization, exact Money and consistent financial
reads remain requirements.

## Existing canonical queries first

Optimize existing canonical queries and their execution paths. Do everything possible to avoid
adding a new canonical query to the schema: a query per screen is not the redesign strategy.
The existing Dashboard view query already composes financial observations; an additional query
would not remove its internal storage trips. Investigate combining compatible admission,
source/context reads, financial snapshots, Audit and final standing inside the existing operation,
while preserving their authority, consistency and recovery guarantees. The minimum safe number
of atomic units must be established rather than assumed.

This constraint concerns canonical query declarations, not SQL statements. Internal SQL batching,
bounded set-based work and request orchestration may change without adding a canonical operation.
Any proposed new canonical query must demonstrate why improving the existing operations cannot
meet the need and return for an explicit design decision; none is authorized by this direction.

## Acceptance direction

The provisional backend processing target is p95 at or below 150 ms, with 50 ms a stretch target.
Processing includes authorization, coordination, database work and response assembly, rather than
only SQL execution. Cold starts are included: active-infrastructure and cold-start cohorts must
each meet the target and be reported separately. A pooled percentile cannot hide either cohort.
This is a target to validate, not a measured feasibility claim. The precise measurement boundaries,
workload and contention envelope still need definition.

Apply the target separately to ordinary Transactions, Budgets, Recurring, Dashboard and Needs
Review reads, including pagination and filter changes. Uploads, extraction, original-file downloads
and institution Synchronization require separate budgets.
Initial latency gates apply to authenticated web reads. Other callers retain shared operation
behavior and regression coverage; their performance budgets are separate.
Exercise every supported ordinary query shape at its documented limits, rather than only default
screens. Reducing an accepted limit requires an explicit product decision. Never silently truncate
financial results or exclude expensive accepted requests from the measurements.

Click-to-fresh-information latency is measured separately, including networking and browser
rendering. The agreed poor-network test profile is 400 ms round-trip latency and 1 Mbps bandwidth,
alongside an ordinary-network baseline. An ordinary screen read should aim for one browser API
round trip with a compact response. This does not imply one internal Worker hop or SQL statement,
nor a 150 ms end-to-end promise on a connection whose round trip already takes 400 ms.
With application code already loaded and no retained product response, the agreed end-to-end
target is p95 at or below one second from interaction to fresh, usable information under the
poor-network profile. Full application startup, including code download and initialization, is
measured separately; its end-to-end budget remains open.

Every performance gate for these reads must exercise a fresh read without reuse of a previously
retained product response. Retained-result navigation has a separate measurement and cannot
satisfy the fresh-read gate. Browser result retention will be evaluated separately after fresh
reads meet their target; it is not being removed by this decision. Exact write-maintained
aggregates, request-local computation reuse and in-flight request deduplication remain available.
The atomic financial projection in ADR 0030 is not a stale response cache.

## Trade-off

Retained responses can improve navigation while concealing slow fresh reads if both are reported
as the same success. Separate acceptance prevents that concealment without requiring every read
to reconstruct exact aggregates from lifetime Transaction history. Structural changes follow
measurements; a broad rewrite is not itself the performance acceptance criterion.

## Workload envelope

Require the ordinary-read targets through 100,000 Transactions, 100 RecurringPlans with 100
revisions each, and 5,000 NeedsReviewItems per User. Fixtures must include mixed Currencies,
Reconciliation links and uneven Category distributions. One million Transactions is initially a
separate stress test rather than part of the latency gate.

Exercise isolated reads and reads during two-tab activity for the same User, ongoing ingestion
and scheduled maintenance. The initial shared-database contention envelope is 20 active Users
averaging one ordinary read per second each. This is a test envelope, not a demonstrated capacity
claim. Record errors and throttling separately; refusing work cannot manufacture a latency pass.

## Verification environment

Use local tests for repeatable diagnosis and the existing deployed web application and Cloudflare
dashboard for live evidence. A separate deployed test environment is not a prerequisite. Local
emulation alone does not establish deployed latency. Browser journey evidence should represent
Colombia; record the actual measurement origin rather than assuming it. Backend timing covers
the complete server path, including internal transport, queueing and cold startup, rather than
only the final handler. Establish which boundaries existing telemetry actually observes before
claiming the target passes. Workload-envelope results require representative controlled fixtures;
ordinary live navigation is not proof of the full load envelope.

Precise timing and cold-start definitions, full application startup and exceptional-operation
budgets remain to be settled. The interview authorized batching existing reads first, followed by
repeat measurements. Data-selection and placement experiments remain separate implementation work.
