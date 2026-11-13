# Per-User Durable Objects own application storage and atomic execution

- **Status:** Accepted migration direction; detailed design and implementation remain open.
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
User storage and execution, global identity routing, background discovery, independent recovery,
schema operations, and acceptance/cutover. The
[platform constraints research](https://github.com/B4rz99/fidy-ai/issues/2199#issuecomment-6839405060)
records source-backed findings and outstanding evidence. Dated research and decision-ticket detail
remain on the tracker.

The map produces an implementation-ready design. This ADR records the chosen direction; it does
not establish that the migration is implemented or authorize a destructive data reset. Fidy is
unreleased and needs no unnecessary backward compatibility, while any retained data still needs an
explicit cutover disposition. Architecture documents continue to describe the current runtime
until implementation changes it.
