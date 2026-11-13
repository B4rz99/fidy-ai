# Per-User Durable Objects own application storage and atomic execution

- **Status:** Accepted migration direction and User storage/execution boundary; remaining map
  decisions and implementation are open.
- **Supersedes:** The D1 storage destination and coordination-only Durable Object role in
  [ADR 0026](0026-cloudflare-native-production-replatform.md), and the initial-platform restriction
  in [ADR 0039](0039-fresh-read-performance-contract.md).

Fidy will replace D1 with SQLite Durable Objects, with one object per stable User owning that
User's application state and atomic execution. Co-locating execution and storage removes the
remote database boundary inside the User's unit of work. This trades the simplicity of a shared
database for explicit global routing, work discovery and recovery protocols. A permanent D1/DO
hybrid is not the destination.

Live User authority checks, domain changes, accounting and Audit remain in one local transaction.
Separate objects own global routing and independent erasure authority. Their exact partitioning
and coordination protocols remain design decisions: a transaction in one object cannot make
changes in another object atomic. R2, Queues and Workflows retain their existing responsibilities
unless a concrete design constraint warrants changing them. Colombia versus North America is not
a storage-placement requirement.

## User storage and execution

The [User storage and atomic execution decision](https://github.com/B4rz99/fidy-ai/issues/2200)
places all User-scoped domain records, projections, credentials and grants, Consent, billing and
accounting, Audit, mutation receipts, outbox intent and hosted execution state in the User object.
Domain owners retain their module boundaries. R2 retains file bytes. Canonical queries and
mutations execute in the User object; the shared read executor's User-data role is retired.
Authentication and routing may resolve the destination beforehand, but the User transaction
rechecks the exact caller's live authority. Directory state supplies routing, never permission.

Short local transactions use the storage-backed Effect SQLite Durable Object adapter. Owner work
joins one transaction containing its authority checks, effects and required accountability. Queries
materialize their bounded result with required accounting and Audit before disclosure. Existing
atomic-batch eligibility, per-child accountability and absence of intra-batch reads are preserved.
External calls run outside transactions, allowing unrelated requests to proceed during provider
waits; hosted Turn serialization remains a separate concern. A later action rechecks its applicable
authority and revisions. Previously admitted processing work retains only its existing bounded
continuation rights. External send authorization takes effect at the durable one-shot claim.
Revocation that removes the attempt's applicable authority before that claim refuses it; an
already-claimed attempt reconciles its outcome.

Ordinary local mutations commit their completed receipt with their effects, Audit and accounting,
avoiding a separately committed pending-request state. A crash commits both effects and receipt,
or neither. The ordinary retry guarantee remains bounded to 24 hours; clients stop automatic retries
after that window. An accepted external job returns its work identity and uses its owner's existing
continuation and reconciliation state. Replay disclosure still requires current authority, and
one-time Secrets never become retained response payloads. This changes transaction composition,
not the commercial charging policy or the meaning of an admitted refusal.

## Shared facts and ordering

Published Prices require one authoritative ordering with new billing admissions. Once publication
completes, every newly started renewal uses the new Price. Existing BillingAttempts and bounded
retries of the same renewal retain their original terms. Publication waits for an in-flight
admission's exact outcome; an uncertain admission can delay or make publication unavailable rather
than permit a late old-price commit. This deliberately favors immediate global pricing correctness
over publication availability. The shared publication protocol does not make an RPC part of the
User's SQLite transaction. Price-change notices require durable distribution and recovery instead
of D1's cross-User notice-insertion transaction.

The app-wide login-email cap becomes a simple shared attempt limiter, separate from the User-local
limit. Both checks must allow the attempt before sending; an allowed attempt that later fails still
counts. There is no distributed capacity reservation or refund protocol. This deliberately replaces
the current atomic User/global accepted-request accounting for that limit; User commercial
accounting and Audit remain local. Other global authentication limits retain their own policies.

Global routing and pre-User bootstrap state, the Price catalog, app-wide admission and independent
erasure authority need explicit shared owners. Shared taxonomy and anonymized structural samples
also need an explicit distribution/retention contract; their existence does not justify splitting
live User authority or User-domain state into more objects. The
[shared catalog and admission decision](https://github.com/B4rz99/fidy-ai/issues/2207) owns those
remaining protocols; the other map tickets retain routing, discovery, recovery and acceptance.

## Adoption evidence

Migration adoption requires measured improvement without correctness regressions. The existing
performance targets remain follow-on objectives; reaching 150 ms is not a prerequisite for this
storage migration. Measurements distinguish backend processing, complete HTTP responses and
click-to-fresh-usable-view latency. [ADR 0039](0039-fresh-read-performance-contract.md) retains the
fresh-read definitions, workload envelope and separate backend/browser targets; this decision does
not turn its 150 ms backend target into a browser-latency claim.

The [infrastructure prototype evidence](https://github.com/B4rz99/fidy-ai/issues/1887) motivates
reducing remote boundaries, but does not establish full-lifetime hosted acceptance, a performance
benefit from per-User partitioning, or complete migration and restore guarantees. Acceptance must
cover isolation, atomicity, revocation, retries, discovery, schema evolution and restore/erasure,
alongside representative latency and load. Exact thresholds and cutover procedures remain open.

## Design boundary

The [migration map](https://github.com/B4rz99/fidy-ai/issues/2198) owns the remaining decisions:
global identity routing, shared-fact protocols, background discovery, independent recovery, schema
operations, and acceptance/cutover. The resolved User storage/execution ticket owns its detailed
decision record. The
[platform constraints research](https://github.com/B4rz99/fidy-ai/issues/2199#issuecomment-6839405060)
records source-backed findings and outstanding evidence. Dated research and decision-ticket detail
remain on the tracker.

The map produces an implementation-ready design. This ADR records the chosen boundaries; it does
not establish that the migration is implemented or authorize a destructive data reset. Fidy is
unreleased and needs no unnecessary backward compatibility, while any retained data still needs an
explicit cutover disposition. Architecture documents continue to describe the current runtime
until implementation changes it.
