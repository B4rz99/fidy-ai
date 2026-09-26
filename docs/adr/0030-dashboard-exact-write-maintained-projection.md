# Dashboard totals are write-maintained from effective Transactions

- **Status:** Accepted

Dashboard totals must remain exact even when a User has more effective Transactions than one read can safely load. Scanning a capped Transaction page would silently understate Money; scanning all history on every Dashboard view would couple ordinary reads to lifetime history. We therefore maintain a User-owned Dashboard projection in D1 on the **effective Transaction** write path, in the same atomic unit as the effective change and its AuditLogEntry. This is a derived read model, not a second source of financial truth.

## Ownership and atomicity

The Transaction owner identifies the old and new effective contribution for every committed transition, including capture, correction, link/unlink, restore, and reconciliation. It subtracts the old contribution and adds the new one inside that transition's D1 unit. A rejected, aborted, or retried mutation must not leave a contribution behind or apply it twice. Store exact Money amounts as integer minor units (or another lossless decimal representation), partitioned by User, Currency, direction, Category, and the dimensions required for Dashboard periods and chart buckets. Do not mix Currency or fabricate a zero total when a projection is missing. Core owns the interpretation of periods and buckets; the Cloudflare adapter owns persistence and D1 decoding. The Dashboard document and its Widget layout remain independent of the projection, so edits do not replay Transaction history.

Calendar grouping uses the User's IANA time zone when the contribution is calculated. A time-zone change invalidates and rebuilds the User's local-day projection as part of a guarded change or explicitly marks it unavailable until a verified rebuild completes; mixing old-zone and new-zone buckets is forbidden. Relative periods resolve to half-open UTC instants in the current zone, including DST transitions. Keep sufficient timestamp detail to resolve rolling seven- and thirty-day boundaries exactly; a local-day bucket alone cannot represent arbitrary instant boundaries. List Widgets remain limited to the requested page (at most 50), with their search and category predicates applied before the limit. They do not determine financial totals.

## Recovery and availability

Backfill pre-existing effective Transactions before enabling projection-backed reads for their User. Record a projection version and readiness/dirty state so partial backfill, schema changes, corruption, or failed time-zone rebuild cannot be mistaken for a complete result. Rebuild from authoritative effective Transaction state with a single guarded cutover; concurrent writes must either be included atomically or invalidate and retry the rebuild. An unavailable or inconsistent projection makes the affected Dashboard view unavailable, **never a partial financial total**. A repair path can rebuild it from canonical state without changing historical Transactions or emitting fabricated success Audits. Test the cutover and recovery paths with more than 8,192 effective Transactions.

## Rejected alternatives

A fixed read limit is not a completeness guarantee. Unbounded history pagination at view time scales with a User's lifetime activity and makes every Dashboard read a recovery attempt. Lazy or eventually consistent accumulation could show stale financial totals immediately after a successful Transaction transition, violating the canonical read contract.
