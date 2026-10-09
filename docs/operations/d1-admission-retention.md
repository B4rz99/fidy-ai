# D1 admission retention incident (#1130)

Production browser pairing returned `503` on 2026-10-09 because D1 refused table access with
error 7500: the account had exhausted its Free daily row-read allowance. Public health remained
available because reachability does not establish database availability.

Cloudflare's D1 analytics reported 5,438,075 reads that day. Six query shapes from the minute's
AI, card-preparation and upload admission sweeps accounted for 4,691,521 reads (86%). This establishes
a dominant internal contributor; it does not establish that all external traffic was legitimate.
The diagnostic's 1,300 rows were synthetic local records, not a count of Production Users.

## Root cause and measured alternatives

The grant primary key uses SQLite's default BINARY collation. Default `LIKE` is case-insensitive
for ASCII, so `id LIKE 'workers-ai-%'` cannot use that index. A `LIMIT 128` after sorting limits the
result, not the preceding scan. Grant deletion also had no batch limit. Running these queries every
minute repeatedly reread unrelated and active admission evidence.

Real local D1, with the checked-in admission schema and 1,300 foreign plus 1,300 active AI grants,
produced these results for the expired-candidate query:

| Alternative                                         | Query plan                                    | Rows read |
| --------------------------------------------------- | --------------------------------------------- | --------: |
| Existing LIKE                                       | Table scan; temporary sort                    |     2,601 |
| Exact GLOB prefix only                              | Primary-key prefix search; temporary sort     |     1,302 |
| Owner partial index on `(admitted_at_epoch_ms, id)` | Covering date-range search; no temporary sort |         1 |

The fix uses three partial indexes for the exact generated owner prefixes and orders candidates by
admission time and identity. Both deletion statements inspect at most 128 grant candidates per
activity. Event expiry and remaining-event guards still protect live spend and retry evidence;
foreign proof/outbox grants are excluded. Upload retains all events while any candidate event is
live. A protected oldest candidate consumes a batch slot until its remaining event expires; the
sweep never scans an unlimited backlog looking for deletable replacements.

Only grants in these three namespaces enter the new indexes. Matching grants incur index storage
and additional indexed writes; foreign grants do not. The migration builds indexes over existing
records once. It changes no grant, event, allowance, expiry or admission limit.

## Verification and Production follow-up

`cloudflare/maintenance/admission-retention.test.ts` executes the published owner sweeps against
real isolated D1. Before the fix, each idle sweep read 8,002 rows with 2,000 foreign and 2,000 active
grants. The regression permits at most 10. Backlog coverage checks bounded reads and progress,
exact expiration, live and case-distinct/foreign preservation, and native batch rollback.
Existing AI, enrollment and upload tests continue to check their admission behavior.

Existing scheduled Work telemetry observes sweep failures; this change needs no per-query logs.
After deployment, use authenticated D1 query insights to compare these six query shapes' aggregate
read usage and check actual browser pairing. Do not infer recovery from `/health` alone.
An exhausted account cannot be restored by a code change that same day: Cloudflare resets the
allowance at 00:00 UTC (19:00 Bogota). If migrations or deployment checks encounter error 7500,
rerun the Production deployment after reset, then measure a complete day's usage and representative
traffic before making a capacity claim. Free-tier sufficiency depends on the complete workload.

Sources: [SQLite prefix optimization](https://www.sqlite.org/optoverview.html#the_like_optimization),
[partial indexes](https://www.sqlite.org/partialindex.html), and
[D1 row accounting and daily reset](https://developers.cloudflare.com/d1/platform/pricing/).
