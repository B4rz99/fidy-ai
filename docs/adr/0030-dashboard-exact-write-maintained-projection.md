# Dashboard totals are write-maintained from effective Transactions

- **Status:** Accepted

Dashboard totals must remain exact even when a User has more effective Transactions than one read can safely load. Scanning a capped Transaction page would silently understate Money; scanning all history on every Dashboard view would couple ordinary reads to lifetime history. We therefore maintain a User-owned Dashboard projection in D1 on the **effective Transaction** write path, in the same atomic unit as the effective change and its AuditLogEntry. This is a derived read model, not a second source of financial truth.

## Ownership and atomicity

D1 triggers maintain one leaf per effective Transaction from the Transaction owner's effective relation; capture, correction, source attestation, reconciliation decision, and link/unlink replace the old leaf with its current effective form inside the mutation's atomic unit. A rejected, aborted, or retried mutation cannot leave a contribution behind or apply it twice. Per-User, Currency, direction, and Category UTC minute/day buckets hold a count, maximum, and positional decimal-digit sums. Digit sums avoid SQLite floating-point aggregation or integer overflow for accepted Money. Core owns period and chart interpretation; the Cloudflare adapter owns persistence and D1 decoding. No missing or invalid projection is converted to a zero financial total. Dashboard edits do not replay Transaction history.

Buckets use UTC, not a stored User-local calendar. On **every read**, Core resolves periods and day/month boundaries from the User's current IANA time zone to half-open UTC instants, including DST changes; the adapter composes full UTC-day buckets and at most two sets of minute fringes. Thus a time-zone change immediately changes the selected interval without invalidating contributions or requiring a backfill. The longest accepted period is at most 32 days; that bounds each view query independently of the User's lifetime history. List Widgets read the same effective leaves through User/recent and User/Category/recent indexes. A filtered list takes at most 50 indexed candidates per requested Category before merging; a search scans only that User's recent-index leaves, applying the exact accent-aware literal substring predicate before its limit of at most 50. This deliberately bounds work by the requesting User's history: common recent matches stop early, while rare or absent terms may visit the whole User-owned history. The previous global FTS candidate scan amplified other Users' matching notes; rowid-constrained FTS probes also amplified global posting-list CPU even when reported row reads stayed low. This predictable-cost tradeoff can make selective queries slower. The existing FTS5 trigram index, padded short-substring maintenance and migrations remain unchanged for a reversible query-only rollout, but this search no longer uses that index. Lists never supply financial totals. Retained FTS still adds write/storage cost, and D1 exports containing virtual tables require extra operational care; it is not the financial source of truth.

Dashboard selects the unique intervals required by its current layout before reading financial facts.
Its published Transaction snapshot reader accepts at most 128 intervals and 24 list pages. Selections
of up to four intervals retain the small native snapshot path. Wider selections first count the
retained bucket and digit rows in their bounded windows, establishing a projection revision. Those
counts conservatively bound the rows returned after grouping. A native snapshot expands beyond four intervals only
while its combined estimate is at most 16,384 rows; larger working sets retain the existing
four-interval ceiling. Thus financial reads still need at most 32 native batches, preserving the
Free invocation query budget and availability for individually large intervals. Bounded
list pages and peer facts accompany the first financial snapshot. Each interval retains separate
count/maximum and positional-digit statements; one batch is one protected trip, not one statement.
Every snapshot checks current Consent, readiness, captured calendar interpretation and the same
projection revision; disagreement with the plan or a later snapshot withholds the complete result.
The encompassing query retains final live caller and required Audit accounting before disclosure.
Later financial snapshots assert the retained revision inside their native unit, so a mismatch or
missing ready revision rolls back final accounting rather than committing it before decoding.
The general multi-period aggregate reader keeps its four-interval chunk protocol.
Identical list selections (limit, Category sequence and search text) share one selected page within
the request. Dashboard restores every Widget identity and position from that page; distinct
selections remain separate. These working structures and decoded facts do not survive the request.

## Recovery and availability

Migration 0020 backfills the effective relation before marking pre-existing Users ready; new Users start with an empty ready projection. Views require the exact supported version and a ready marker. Reconciliation decisions transiently mark a User `linking` and return to ready only after both members have been maintained (or both removed); direct incomplete changes cannot masquerade as a complete view.

The Core Worker runs repair every minute, processing up to four incomplete Users each tick, ordered by their last attempted time so a broken User cannot starve another's recovery. Each per-User step clears or copies at most 256 bucket, digit, or leaf rows, with cursor progress persisted in D1; the marker remains unavailable through three clearing phases and rebuilding. During clearing, effective changes update leaves but do not touch aggregates being discarded; during rebuilding, triggers maintain both leaves and aggregates. Each bounded rebuild page compares its copied leaves with the canonical effective relation before advancing; a mismatch dirties the marker and restarts repair. The final guarded cutover checks that no canonical row remains past the cursor and that Reconciliation decisions are complete in the same D1 batch. Clearing began with an empty leaf set, and triggers maintain every committed change throughout rebuilding, so no earlier copied leaf can become stale or extra between page verification and cutover. A failed step retains the unavailable marker and is retried by a later scheduled tick; no view executes the rebuild lazily. For a static 8,193-Transaction User with no other repairs ahead of it, at most 35 clearing and 33 rebuilding ticks (68 scheduled minutes after repair begins) complete the repair; with competing Users the fair queue adds at most one tick per four incomplete Users per step. Larger histories require proportionally more ticks, not permanently unavailable views due to a fixed history cap. Scheduled failures are reported as failed activities. A corrupt aggregate with an undamaged ready marker is not automatically detected; operators must mark that User dirty to start a rebuild. No historical Transaction or fabricated success Audit is written by repair.

## Rejected alternatives

A fixed read limit is not a completeness guarantee. Unbounded history pagination at view time scales with a User's lifetime activity and makes every Dashboard read a recovery attempt. Lazy or eventually consistent accumulation could show stale financial totals immediately after a successful Transaction transition, violating the canonical read contract.
