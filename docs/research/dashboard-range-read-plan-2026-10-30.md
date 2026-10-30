# Dashboard range-read optimization decision

**Prototype a bounded multi-range Transactions read locally before parallelizing Dashboard reads.**
The present layout loader serializes unique aggregate intervals, so day charts can accumulate many
round trips. Concurrency four may hide network latency, but does not reduce database requests or
fix the Free per-invocation ceiling. There is no measured latency gain or production candidate yet.
The default layout shares one aggregate interval; it has no range-level parallelism to exploit.

## Current execution and authority

[`findRanges`](../../apps/server/cloudflare/dashboard/internal/dashboard-view.ts) deduplicates by
`from:toExclusive` in a request-local Map, then awaits each interval sequentially. Base list/context
and budget reads already overlap at concurrency two and finish before range reads begin. The
[native default-layout test](../../apps/server/cloudflare/dashboard/internal/dashboard-view.test.ts)
asserts five round trips and maximum concurrency two; no default-layout gain should be claimed.

Each [Transactions aggregate](../../apps/server/cloudflare/transactions/internal/dashboard-projection.ts)
is one `db.batch()` containing a current Consent/projection-readiness selection and two exact
Currency-preserving projection queries. The
[guarded database](../../apps/server/cloudflare/erasure/internal/database.ts) additionally reads
the fresh R2 generation and prepends its D1 assertion to that same batch. Preserve this boundary.

Dashboard document/view queries are explicitly sent through the same User's coordinator by
[`executeCanonicalHttpQuery`](../../apps/server/cloudflare/canonical-operations/operations.ts).
The [owner](../../apps/server/cloudflare/dashboard/operations.ts) checks live caller authority,
loads and presents the complete view, and requires final credential/accounting/Audit success before
releasing data. The existing delayed-chart/Correction and late-authority/Audit failure tests in
[`dashboard.test.ts`](../../apps/server/cloudflare/dashboard/dashboard.test.ts) are required
regression evidence for either optimization. Inner parallelism must remain inside that turn and
the existing admission lease; it must not introduce detached work or cached authority.

## Provider constraints

A `db.batch()` counts as **one** query against the Free **50-query per-Worker-invocation limit**,
regardless of its statement count. Thus 31 daily ranges do not consume 93 invocation queries merely
because each aggregate has three statements; they consume 31 batch calls, plus the rest of the
request. Multiple allowed chart periods can still exceed the complete invocation's ceiling.
Cloudflare processes one database's queries serially and recommends fewer requests/batching to
reduce request overhead. Individual SQL size/parameter bounds and the batch duration limit still
apply. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Four range reads are below D1's documented six simultaneous connections, but the limit is shared
with the top-level invocation, including service-bound Workers. The Workers limit now counts
connections waiting for response headers; it is not a promise of four SQL queries executing in
parallel. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Preferred prototype and acceptance checks

Keep SQL in Transactions. Add a bounded owner operation accepting a deduplicated set of half-open
intervals and returning complete results keyed by interval. Reuse the existing exact projection
queries in bounded native batches, with current Consent/readiness and fresh recovery fencing per
batch. This reduces request count without first redesigning the projection SQL. Bound total unique
intervals, statements, returned groups and the complete request's provider budget; do not replace
bounded facts with an unbounded history scan. Evaluate combined-range SQL only if measurements show
that native batch overhead remains material, and verify its index plan and per-query parameter bound.

Before any hosted experiment, prove equivalent exact Money, interval boundaries in local time,
cross-User isolation, readiness/refusal handling, duplicate-range reuse, deterministic widget order,
whole-view unavailability on one invalid range, and coordinator/Audit/lease behavior. Retain the
default-layout cost check. Measure at least a multi-day chart and a multi-period layout, including
the full invocation query count, reads/writes and response equality. SQL/native-call reductions are
not production latency, CPU or billing evidence.

If bounded concurrency is prototyped instead, collect unique interval identities **before** starting
reads: concurrently invoking the current `findCached` can miss the same not-yet-populated Map entry
and duplicate work. Selected Effect 4.0.6 `forEach` preserves result order and accepts finite
concurrency. Its concurrent implementation interrupts sibling fibers on failure, but `Option.none`
is a successful value and does not short-circuit. D1 promises do not accept an AbortSignal here;
interrupting Effect waiters cannot prove native reads stopped. Do not release the coordinator turn
or admission lease with newly detached native work. Preserve bounded settlement on failure and
cancellation rather than relying on fiber interruption alone. See the selected
[Effect source](https://unpkg.com/effect@4.0.6/src/internal/effect.ts) and
[repository concurrency reference](../../.patterns/concurrency-time.md).

This investigation was read-only. No implementation, production request cohort, provider resource
or deployment was created for it. Keep #1589 open; neither approach yet establishes a 2× gain.

## Local prototype evidence

A Transactions-owned implementation now prepares ordered intervals in sequential batches of four,
up to 128 intervals. Each batch retains current Consent and projection readiness; all batches must
agree on the fact revision. Dashboard deduplicates interval identities before reading and restores
widget/bucket order afterward. Native provider calls remain sequential inside the same coordinated
query, with its existing admission lease, fresh recovery fence per batch and final authority/Audit.

The native regression test first failed with **36 calls instead of the targeted 12** for an October
daily chart. The prototype then passed with **12 calls**, all 31 day buckets plus two complete
shared-period projections intact. The default layout remains at five calls. Native tests also reject
the whole read after a valid Consent withdrawal or a fact-revision change between chunks, without
starting a third chunk. These are native footprint/correctness observations, not hosted or production
latency evidence. Hosted timing, current authenticated production baseline, required CI and deployment
validation remain pending. The candidate is not deployed.
