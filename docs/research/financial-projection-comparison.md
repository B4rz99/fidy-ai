# Financial projection comparison — #1464

Measured locally on 2026-10-22 against checkpoint `db8699117`, using the installed Bun
1.4.3-canary.1, Miniflare 5.20260911.1-alpha, and the native D1 integration harness.
This is local query/trigger evidence, not production latency, deployment verification, or a live
D1 quota measurement. No remote database was queried or modified.

## Selected target

Retain the four Transactions-owned tables for #1465. Rename them to
`transaction_projection_state`, `transaction_projection_leaf`, `transaction_projection_bucket`
and `transaction_projection_digit`; convert true instants to integer milliseconds and remove only
the validated duplicate decimal maximum. Dashboard layout stays in `user_documents`.

| Retained store | Evidence and responsibility                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State          | Authoritative `fact_revision`, original first-capture instant and captured timezone must survive; repair readiness/cursor cannot substitute for those facts. Repair preserved this group exactly in every measured scenario.                                                                                                                                                |
| Leaf           | Linked History and Recurring pages avoid enumerating the retained pair graph. At 20,000 retained records, direct queries visit hundreds of thousands of rows for small pages; indexed leaf reads visit hundreds. It also supports indexed effective search and bounded list pages.                                                                                          |
| Bucket         | Exact aggregate queries return bounded per-Currency/direction/Category groups without transferring every matching movement. Its read work follows aggregate coordinates rather than the number of returned movements. Dense monthly cases demonstrate a latency benefit over lean leaf arithmetic; small histories can favor leaf arithmetic.                               |
| Digit          | Retained with buckets as their measured exact-sum representation, including zero-, two-, three- and four-fraction Currencies and values beyond binary floating-point precision. Removing bucket/digit together was measured via leaf arithmetic; no claim is made that exact Money inherently requires a digit table or that every possible representation was benchmarked. |

This decision prioritizes predictable read work and complete exact aggregates over fewer tables.
It does not establish that the existing maintenance implementation is cheap: its amplification and
repair costs below are material. Keep the original unavailable-versus-fallback behavior and one
Transaction-owned effective-fact policy. A generic cache or a second runtime calculation path is
not part of this decision.

If projections were removed, the independent per-User fact group would still have to remain in
Transactions-owned persistence. The existing state table is its current authority; a direct-only
alternative could retain that table with only `user_id`, fact revision, first capture and timezone.
It cannot drop those values, derive them from a currently retained movement, use workflow progress,
or silently append financial ownership to Identity's approved core. That alternative is not the
selected target and does not authorize a new table.

## Reproduce

```sh
INFRA_PERFORMANCE_MEASURE=1 bun run --cwd apps/server test:cloudflare cloudflare/transactions/projection-comparison.test.ts
```

The executable comparison is
[projection-comparison.test.ts](../../apps/server/cloudflare/transactions/projection-comparison.test.ts).
[Raw observations](financial-projection-measurements.csv) contain all 420 measurements. Every
measurement is metadata only: dimensions, native rows read/written, statement count and elapsed
milliseconds. Query-plan details are emitted separately as `INFRA_PLAN` by the same command.

The six ordinary-density histories contain 200, 2,000 or 20,000 retained movements per User, with either no linked
pairs or all base movements paired. A second User has an equally large history. Eight additional
precision/interval-boundary movements exercise COP, USD, JPY, KWD and UYW, large decimal Money,
one-millisecond interval edges and independent Currency groups. Two additional 20,000-movement
histories use one-minute spacing, concentrating the base history within fourteen days. Creation instants in the shared
history builder follow occurrence by one second instead of extending decades into the future.
The aggregate interval is `[2020-01-01T05:00Z, 2020-01-29T05:00Z)`, including partial UTC days.

Each read has five samples. Tables show maximum native rows read / median elapsed milliseconds;
read paths wrote zero rows. Fixed execution order and shared local transport/cache warm-up limit
latency conclusions; row counters are the primary cost evidence. Ordinary-density large-history base occurrences
span approximately 278 days, with about 2,016 base movements in the aggregate interval. This is
not a claim that all possible activity densities or input lengths have been measured. The dense
cases separately exercise a large monthly result set, with the same foreign-User history.

## Equivalent read results and query plans

- **Direct:** current authoritative effective relation. Aggregate queries select only amount, Currency, direction
  and Category; those fields use their owned codecs and exact BigDecimal sum/maximum arithmetic.
  Full Transaction identity, description, revision and timestamp decoding is excluded from this
  calculation, so direct and leaf aggregation avoid unrelated decoding work.
- **Indexed:** an additional direct candidate for histories without any active pair; numeric
  timestamp predicates and ordering use original-row indexes. The query itself requires that
  no linked decision exists. Its results must equal the authoritative relation. It is not a
  solution for histories with linked effective facts.
- **Leaf arithmetic:** same exact application aggregation over indexed materialized leaves,
  independently testing whether bucket/digit add value beyond the leaf table.
- **Materialized:** indexed leaves for History and Recurring-shaped pages; the current published
  aggregate reader for exact bucket/digit totals and maxima.

All candidates returned identical complete selected facts or exact aggregate groups in every
sample. Independent expected values check KWD `0.004` and the in-range COP maximum
`9007199254740993.01`; larger out-of-range values must not affect that maximum. History pages
contain at most 101 rows; Recurring-shaped ascending cursor pages contain at most 128. These
are native SQL/read-model comparisons; common HTTP authentication, Audit, coordinator and
Recurring decoder/context work are outside the page-query timing. The aggregate materialized
reader includes its real Consent/readiness query. No alternate reader is installed in production
by this benchmark ticket.

| Retained base count | Minutes between facts | Paired | Reader    | Direct rows / ms | Indexed direct rows / ms | Leaf arithmetic rows / ms | Materialized rows / ms |
| ------------------: | --------------------: | :----: | --------- | ---------------: | -----------------------: | ------------------------: | ---------------------: |
|                 200 |                    20 |   no   | history   |       626 / 1.67 |               101 / 1.32 |                         — |             101 / 1.15 |
|                 200 |                    20 |   no   | recurring |       214 / 0.66 |                 4 / 0.59 |                         — |               4 / 0.61 |
|                 200 |                    20 |   no   | aggregate |       401 / 2.02 |               193 / 1.71 |                193 / 1.56 |           2,283 / 2.34 |
|                 200 |                    20 |  yes   | history   |     4,320 / 2.39 |                        — |                         — |             101 / 1.04 |
|                 200 |                    20 |  yes   | recurring |     1,815 / 1.03 |                        — |                         — |               4 / 0.53 |
|                 200 |                    20 |  yes   | aggregate |     4,048 / 2.15 |                        — |                100 / 0.89 |           1,231 / 1.19 |
|               2,000 |                    20 |   no   | history   |     6,026 / 4.76 |               101 / 1.05 |                         — |             101 / 0.99 |
|               2,000 |                    20 |   no   | recurring |     4,000 / 2.50 |               257 / 0.98 |                         — |             257 / 0.89 |
|               2,000 |                    20 |   no   | aggregate |     4,001 / 8.06 |             1,993 / 5.74 |              1,993 / 5.88 |          17,158 / 3.12 |
|               2,000 |                    20 |  yes   | history   |   43,019 / 13.55 |                        — |                         — |             101 / 0.96 |
|               2,000 |                    20 |  yes   | recurring |    30,414 / 9.77 |                        — |                         — |             257 / 0.84 |
|               2,000 |                    20 |  yes   | aggregate |   41,848 / 16.39 |                        — |              1,000 / 3.06 |           8,906 / 2.15 |
|              20,000 |                    20 |   no   | history   |   60,026 / 53.70 |               101 / 4.07 |                         — |             101 / 2.71 |
|              20,000 |                    20 |   no   | recurring |   58,000 / 39.05 |               257 / 2.65 |                         — |             257 / 2.73 |
|              20,000 |                    20 |   no   | aggregate |   22,031 / 29.15 |            2,023 / 14.74 |             2,023 / 14.44 |          17,563 / 6.69 |
|              20,000 |                    20 |  yes   | history   | 430,019 / 135.23 |                        — |                         — |             101 / 1.16 |
|              20,000 |                    20 |  yes   | recurring | 417,414 / 129.48 |                        — |                         — |             257 / 1.13 |
|              20,000 |                    20 |  yes   | aggregate |  204,208 / 79.05 |                        — |              1,015 / 2.91 |           9,103 / 2.04 |
|              20,000 |                     1 |   no   | history   |   60,026 / 35.93 |               101 / 1.04 |                         — |             101 / 1.08 |
|              20,000 |                     1 |   no   | recurring |    20,014 / 8.89 |                 4 / 0.54 |                         — |               4 / 0.54 |
|              20,000 |                     1 |   no   | aggregate |   39,716 / 67.50 |           19,708 / 46.94 |            19,708 / 47.81 |        170,525 / 19.02 |
|              20,000 |                     1 |  yes   | history   | 430,019 / 136.72 |                        — |                         — |             101 / 1.17 |
|              20,000 |                     1 |  yes   | recurring |  180,015 / 60.59 |                        — |                         — |               4 / 0.74 |
|              20,000 |                     1 |  yes   | aggregate | 416,417 / 161.99 |                        — |             9,857 / 23.73 |         85,466 / 10.68 |

Native plans use the User-qualified `sqlite_autoindex_transactions_2` for linked member lookups,
`transactions_by_user_occurrence` for eligible original-row range/order queries, and
`dashboard_projection_leaf_recent` for materialized recent pages. Aggregate groups/digits use
User/width/bucket index ranges. The current mixed minute/day `OR` query still scans minute
coordinates it later excludes: leaf arithmetic can read fewer rows. Small histories favor lean application arithmetic in some
samples; the retained aggregate representation earns its place on dense histories and bounded
result transfer rather than a claim of universal latency or row-count superiority. Retention of bucket/digit is not a claim that the current query plan is
optimal. Recurring's current source-backed reader remains correct; the leaf result demonstrates
an available ready-projection optimization only if its authoritative fallback and revision fence
remain intact in #1465.

## Financial mutation amplification

These are native financial units, not complete canonical-operation costs: a two-movement manual
capture includes two Transactions and two SourceAttestations; correction includes immutable
before/after evidence plus a revision update; link/unlink update decision and both memberships.
The no-projection comparison disables only projection-maintenance triggers, retaining authoritative
fact-context triggers and all other installed constraints. Fresh otherwise equivalent pairs are
used in each mode. Authorization/Audit/coordinator costs common to both are excluded. One sample
per mutation/scenario makes latency descriptive, not a percentile or a service-level promise.
The direct baseline retains state metadata; it is not evidence that all four tables can disappear.

At 20,000 base rows, counts below include indexes and trigger side effects, not only application rows.

| Paired history | Mutation   | No projection maintenance: read / written / ms | Current projections: read / written / ms |
| :------------: | ---------- | ---------------------------------------------: | ---------------------------------------: |
|       no       | capture    |                             80,068 / 24 / 8.52 |                     80,578 / 164 / 22.05 |
|       no       | correction |                                  11 / 5 / 1.46 |                         367 / 103 / 9.62 |
|       no       | link       |                                   9 / 7 / 1.44 |                        467 / 123 / 14.01 |
|       no       | unlink     |                                  12 / 4 / 1.40 |                         452 / 131 / 6.73 |
|      yes       | capture    |                             80,068 / 24 / 7.41 |                    120,565 / 171 / 15.30 |
|      yes       | correction |                                  11 / 5 / 1.22 |                      20,375 / 103 / 6.38 |
|      yes       | link       |                                   9 / 7 / 1.36 |                      20,473 / 127 / 6.76 |
|      yes       | unlink     |                                  12 / 4 / 1.25 |                      20,454 / 135 / 6.54 |

## Repair complexity

The benchmark dirties a complete projection and runs the actual bounded repair to readiness,
asserting both exact aggregate equality and unchanged authoritative fact revision/first capture/
timezone. Each repair call retains the existing 256-row phases; the harness caps the total calls
at 2,000. Aggregate validation and the dirty-marking write are outside the measured repair window.
A direct-only read model has no derived cache to repair, represented by zero repair statements;
that does not eliminate its separate authoritative metadata or normal mutation work.

| Base rows | Minutes between facts | Paired | Repair rows read | Repair rows written | Statements | Local elapsed ms |
| --------: | --------------------: | :----: | ---------------: | ------------------: | ---------: | ---------------: |
|       200 |                    20 |   no   |           40,348 |               8,442 |         72 |            48.72 |
|       200 |                    20 |  yes   |           35,154 |               4,549 |         51 |            35.18 |
|     2,000 |                    20 |   no   |        1,471,583 |              79,189 |        576 |           426.74 |
|     2,000 |                    20 |  yes   |          812,010 |              40,122 |        302 |           318.65 |
|    20,000 |                    20 |   no   |      123,095,425 |             786,654 |      5,709 |         13273.38 |
|    20,000 |                    20 |  yes   |       59,862,444 |             395,848 |      2,901 |         10465.52 |
|    20,000 |                     1 |   no   |      119,987,193 |             782,430 |      5,653 |          8057.95 |
|    20,000 |                     1 |  yes   |       58,300,920 |             391,640 |      2,845 |         11701.08 |

Repair is exceptional work, but repeated effective-relation scans make its total read cost large;
bounded pages do not imply a cheap whole repair. Linked mutations also revisit User-wide pair
state. Neither issue is solved by renaming tables. Preserve restart, concurrent-mutation and
readiness safeguards, and use these measurements to check regressions while installing #1465.

No schema change is needed to complete the measurement gate itself. The synchronized target
schema/readers/writers, maximum reconstruction validation, populated conversion/rollback proof,
logical erasure purposes and archive addresses belong to #1465. Historical `max_minor` and digit
positions currently use a fixed four-decimal scale, even for COP/JPY; never reinterpret those
coordinates using Currency precision when removing `maximum`. Reconstruct the original exact
Money with that stored scale and validate the resulting Currency precision.

## Target-schema validation — #1465

The same eight-scenario executable comparison passes on the renamed stores with numeric leaf/state
instants and exact maximum reconstruction. [Target-schema observations](financial-projection-cutover-measurements.csv)
retain all 420 observations separately from the original decision evidence. Wire-equivalent History
and Recurring-shaped pages, exact aggregate groups, and unchanged authoritative fact context are
asserted before/after real bounded repair. The final source view exposes numeric instants alongside
its public-format aliases; native projection predicates/order use the indexed numeric fields.

At 20,000 retained base movements, ready History still reads 101 rows; the ordinary-density
Recurring-shaped page reads 257. Dense-history aggregate reads remain 170,525 rows unpaired /
85,466 paired, including the known minute/day-selection overhead. These are preservation checks,
not a claim that the existing aggregate plan is optimal. Removing the duplicate maximum also removes
one repeated bucket update on deletion: in the ordinary-density paired scenario, capture writes
167 rows (previously 171), correction 99 (103), link 121 (127) and unlink 131 (135). Full repairs
remain expensive and their maintenance protocol is preserved.

One run concurrent with other native suites returned `ProjectionRepairFailed`; the isolated
20,000-row linked scenario and subsequent complete serial run both passed. Its cause was not
established. The reported measurements are from the complete serial run and provide no evidence
about concurrent worker capacity or production latency. No speculative runtime workaround was added.
