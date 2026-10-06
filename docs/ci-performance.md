# CI performance

For the measured follow-up and remaining Linux evidence requirements for #922–#926, see
[CI follow-up: #922–#926](ci-improvements-922-926.md).

## Adapter regression follow-up: #1066

The last 50 actual adapter shard jobs on October 5–6 contained 45 successes, three failures,
and two cancellations. Successful jobs had a 4m23s median, a 5m11s mean, and an 11m30s maximum;
eight exceeded eight minutes. Median time outside adapter validation was 34 seconds.

[Historical run 37542170991](https://github.com/B4rz99/fidy-ai/actions/runs/37542170991)
passed 1,352 cases in 100 files. Its four validation steps took 221s, 627s, 233s and 312s.
OAuth ingress accounted for 181 cases and 430s, while its missing scheduling weight estimated
one second. Those figures diagnose the regression; they are not a controlled comparison with
this change's revision.

The OAuth composition now has seven independently scheduled suites: bootstrap/approval,
confirmation, canonical execution, management, refresh, discovery, and native residency.
All 181 historical case titles map exactly once, and all 103 original test/describe AST nodes
match after normalizing only the extracted fixtures' named arguments/defaults. The fixtures
retain independent databases and coordinators, including the predecessor-migration paths.
Weights are explicitly single-run estimates, refreshed from the first successful Linux PR run
after the split and fixture optimization. The existing four
runners and serial file execution remain unchanged.

Pooled D1 fixtures now prepare their baseline batch inside the same native Worker rather than
making one synchronous Miniflare proxy call per statement. Every fresh binding still executes
every requested migration, with actual constraints, triggers, seeds and transactional rollback.
Unregistered/wrapped D1 bindings retain the ordinary batch path; file-by-file migration tests
continue using `applyTestMigration`. No database, mutable schema or coordinator is reused.

Three alternating local before/after measurements installed all 87 migration files into 16 fresh
D1 bindings per run, with Bun 1.4.1 and Miniflare 5.20260911.1-alpha on macOS arm64:

| Schema installation seconds | Run 1 | Run 2 | Run 3 | Median |
| --------------------------- | ----: | ----: | ----: | -----: |
| Original proxy preparation  | 7.533 | 7.521 | 7.556 |  7.533 |
| Worker-local preparation    | 4.812 | 4.827 | 4.814 |  4.814 |

This is a 36.1% reduction in schema installation, not a whole-suite or Linux guarantee.
The benchmark excludes acquisition and disposal; warmed binding acquisition totals were
0.10–0.23s per run. The first cold baseline additionally took 1.83s to acquire its bindings.

Recurring pagination/scan arrangements replace 228 sequential fixture INSERT requests with two
real D1 batches. Payment enrollment arranges the elapsed retained verification cooldown instead
of sleeping four seconds and also proves a premature retry stays pending. No behavioral tests
were deleted: the inspected expensive cases protect distinct isolation, atomicity, recovery,
resource or protocol failures. The focused fixture/Recurring/payment run passed all 87 tests.
[First Linux PR run 37545947947](https://github.com/B4rz99/fidy-ai/actions/runs/37545947947)
passed all four shards: 1,343 executed cases and nine existing environment-gated cases. The native
host and provider Sandbox gates retain their original conditions. Suite elapsed times were
254.0/161.8/267.4/310.3s, so the historical weights left a 148.5s spread after the uneven fixture gains.
The follow-up scheduling estimates use those actual split-file timings. The final PR-head run must
validate the updated assignment before merge; these two revisions must not be pooled into a median.

## Linux CI confirmation

[Checks run 36649040251](https://github.com/B4rz99/fidy-ai/actions/runs/36649040251) on
PR [#919](https://github.com/B4rz99/fidy-ai/pull/919) passed every check, including all 511 adapter
tests. Runner count and matrix size remain unchanged; files remain serial within each runner.

Compared with [baseline run 36638591445](https://github.com/B4rz99/fidy-ai/actions/runs/36638591445):

| Measurement                                      | Before | After |
| ------------------------------------------------ | -----: | ----: |
| Slowest adapter validation step                  |  6m08s | 1m20s |
| Slowest complete adapter job                     |  6m39s | 1m56s |
| Overall Checks workflow (creation to completion) |  6m49s | 3m13s |

Adapter validation's critical-path time decreased by about 78%; its longest complete job decreased
by about 71%. Overall workflow time is also affected by the intervening trunk change-selection
workflow, runner startup variance, and the browser job, so it is not a controlled attribution of
all savings to this PR.

The four JSON timing artifacts report 79.31s, 68.36s, 78.36s, and 72.13s of suite elapsed time.
The upload step takes approximately one second per shard. Scheduling weights were subsequently
refreshed from these Linux file durations, rather than workstation estimates.

### Remaining bottlenecks

- Browser validation is now the critical path: the job took 2m47s, including 1m40s for validation
  and approximately 54s before it (checkout, dependency setup, and Chromium setup).
- Largest adapter files: Transactions 54.10s, statement ingestion 43.31s, hosted Turns 37.47s.
  These numbers include fixture setup; they do not separately attribute startup, migrations,
  seeding, behavior, and disposal.
- Slowest individual adapter case: Dashboard totals beyond 8,192 effective Transactions, 3.76s.
  The next cases were concurrent upload admission (1.88s), multi-chunk statement processing
  (1.55s), InsightEvent pagination (1.50s), and Budget pagination (1.40s). These protect real
  resource and persistence behavior; deleting them is not an optimization.

The browser investigation below separates startup/build costs from journey waits. A further adapter
investigation should split fixture setup time from behavior in the three largest files before making
more changes. Additional static-byte/digest caching is not justified by these coarse timings.

## Browser timer follow-up

Baseline Linux run 36649648547 spent approximately eight seconds starting the built static host and
real Core fixture, then approximately 93 seconds executing 37 tests. The browser job's validation
step took 1m40s, while the complete job took 2m20s. Build startup was not the dominant cost.

Per-test local profiling confirmed repeated five-second sign-in delays, a fifteen-second slowdown
case, and a six-second expiry case. No workers or concurrency were added:

- Journey sign-in fixtures install the browser clock before navigation, approve through the real
  loopback operator, then advance the first polling timer by five seconds. The redemption must
  return HTTP 200 from real Core before the helper accepts sign-in. Core time, private proof
  verification, rate limits, D1, and session creation remain real. Browser wall time is restored
  after sign-in so the virtual advance cannot skew the following financial journey.
- The mocked expiry case advances to its first poll, proves a request is pending without terminal
  refusal, then advances beyond expiry and proves refusal without a second poll or new pairing.
- The sequential cadence, slowdown, email approval, support recovery, and dedicated real pairing
  journeys retain real-time waits. Their assertions were not removed or weakened.
- CI preserves per-test JSON timings without collecting browser traces, screenshots, or video.
- Browser binaries are cached by the installed Playwright version, OS, and architecture, not the
  entire workspace lockfile. Unrelated dependency updates therefore no longer invalidate Chromium.
  System dependencies are still installed; the cache does not substitute for them.
- Cloudflare dev-only typings were advanced to 5.20260923.1 when the seven-day dependency policy
  began requiring that version during validation; no Worker runtime dependency was changed.

Local execution of all 37 tests decreased from **114.51s to 50.73s and 65.40s** (43–56%). These
runs used Playwright's Node CLI, the same built production-mode artifact and two workers, and freshly
seeded real Core fixtures; timings exclude manually prepared servers. Manual startup avoids the
separate local Bun executable-resolution problem described below. Workstation contention makes
Linux CI the preferred confirmation.

[Linux run 36654129458](https://github.com/B4rz99/fidy-ai/actions/runs/36654129458) confirmed all
37 browser tests passed without retries. Browser validation decreased from **1m40s to 52s** (48%),
including approximately seven seconds of server startup. The complete browser job decreased from
**2m20s to 2m06s**, despite Chromium/dependency installation taking 33s instead of 13s and the preceding
setup taking longer. This illustrates why suite speedup is not a guarantee about overall job time.
The timing evidence is specific to the browser gate, not a claim that every sibling job passed in
that run. The clock-restoration helper now uses Effect Clock, as required by the static gate.

## Adapter phase follow-up

Temporary phase counters around Transactions fixture setup identified migrations as the dominant
cost in a 74-test run (77 independent setups):

| Phase                     | Per-file batches | Whole-schema fixture batch |
| ------------------------- | ---------------: | -------------------------: |
| Database acquisition      |            2.05s |                      1.46s |
| Migration execution       |           28.70s |                     14.78s |
| Authentication seeding    |            1.52s |                      1.01s |
| Disposal                  |            0.11s |                      0.05s |
| Transactions file elapsed |           41.25s |                     22.37s |

Migrations accounted for about 70% of the initial file time. `installTestSchema` now installs an
ordered baseline in one transaction into each fresh fixture database, without parallel reads or
SQL execution. It is used by Transactions, ordinary hosted Turns, PATs, Budgets, Dashboard, statement
ingestion, and statement processing. The single-file helper remains for actual migration boundaries;
the hosted Turn migration that seeds a legacy Turn between files retains its original path. Neither
production migrations nor real coordinator/runtime isolation were changed.

The fixture checks now exercise multi-file seeds, trigger enforcement, and foreign-key rejection
on separate bindings. A new negative proves that failure in a later file rolls back the complete
fixture schema. Temporary profiling counters were removed.

Local full-suite runs passed: 511 tests before in 159.42s; 512 tests after in 150.06s. These timings
were affected by heavy workstation contention and are not a reliable estimate of Linux gains. A
second local full-suite repeat was stopped at 300 seconds during extreme contention (load average
above 100), without relaxing test timeouts or changing concurrency.

[Linux run 36658908035](https://github.com/B4rz99/fidy-ai/actions/runs/36658908035) passed every
check and all 512 adapter tests. Against the immediately preceding run 36655169639:

| File                 | Before |  After |
| -------------------- | -----: | -----: |
| Transactions         | 85.00s | 49.60s |
| Statement ingestion  | 44.88s | 41.85s |
| Hosted Turns         | 39.64s | 35.84s |
| PATs                 | 20.99s | 15.41s |
| Budgets              | 16.33s | 13.74s |
| Dashboard            | 15.96s | 10.88s |
| Statement processing |  8.30s |  6.17s |

The slowest adapter validation step decreased from 2m01s to 1m24s; the slowest complete job from
2m41s to 1m58s. This comparison includes runner variability, notably the unusually slow preceding
Transactions run; it is not a stable percentage guarantee. Shard weights were subsequently refreshed
from run 36658908035 to account for the changed fixture costs.

## Local measured results

Local measurements with Bun 1.4.1 and Vitest 5.0.1 on the same macOS workstation. Adapter
files run serially, without additional workers or larger runners. These are not Linux CI
wall-clock guarantees. Setup, imports, execution, and teardown are included in suite elapsed time.

The baseline includes the first optimization pass (balanced shards, cached coordinator bundles,
and one consolidated duplicate-call-id test). The subsequent comparison is **unsharded**:
shard balancing therefore cannot explain its improvement.

| Adapter suite  |  Before | After, run 1 | After, run 2 |
| -------------- | ------: | -----------: | -----------: |
| Complete suite | 249.60s |      116.09s |      111.20s |
| Passing tests  |     507 |          511 |          511 |

The four additional cases prove fixture isolation. The final run reduced elapsed time by 55.4%
(2.24x throughput for the complete serial run).

The refreshed four-shard configuration was also exercised sequentially on the same workstation:

| Shard | Elapsed | Passing tests |
| ----- | ------: | ------------: |
| 1/4   |  36.73s |           129 |
| 2/4   |  29.77s |           142 |
| 3/4   |  29.51s |           125 |
| 4/4   |  28.83s |           115 |

All 38 files were assigned exactly once and all 511 tests passed. Sharded processes have their
own startup/import costs, so their summed time is not identical to the unsharded measurement.
These workstation numbers are separate from the GitHub-hosted runner results above.

Selected test-file elapsed times from the baseline and final run:

| File under `apps/server/cloudflare/`     | Before |  After |
| ---------------------------------------- | -----: | -----: |
| `transactions/transactions.test.ts`      | 53.38s | 18.86s |
| `ingestion/statement-ingestion.test.ts`  | 42.13s | 16.98s |
| `agent/hosted-turn.test.ts`              | 32.78s | 12.60s |
| `pats/pats.test.ts`                      | 19.39s |  7.54s |
| `budgets/budgets.test.ts`                | 13.52s |  5.66s |
| `dashboard/dashboard.test.ts`            | 13.55s |  5.19s |
| `categories/keyword-rules.test.ts`       |  9.56s |  3.20s |
| `ingestion/statement-processing.test.ts` |  8.15s |  2.95s |

Web verification was benchmarked separately, twice, without concurrent static verification:

| Commands                                                      |  Run 1 |  Run 2 |
| ------------------------------------------------------------- | -----: | -----: |
| Ordinary tests + coverage + selected deployment-adapter tests | 12.69s | 12.17s |
| Coverage alone                                                |  6.32s |  6.23s |

Coverage executes all ordinary web tests, including the deployment-adapter files, and retains
Istanbul thresholds. The removed runs were repeated execution, not distinct coverage.

## Implemented changes

- `cloudflare/d1-test-fixture.ts` caches immutable migration text and applies each file's ordered
  statements as one D1 batch, retaining actual schema, triggers, constraints, and seed data.
- D1-only and ordinary D1/R2 fixtures reuse a Worker process across up to sixteen independent
  binding slots. Each slot is acquired once: no database or bucket is reset or reused.
- Tests that exercise native Durable Object bindings or runtime lifecycle retain fresh runtimes.
  No in-memory replacement for D1 or R2 was introduced.
- Auth fixture inserts for Budget, Dashboard, and statement ingestion are batched in dependency
  order. Clock-dependent values and mutable state are still created per test.
- `scripts/verify.ts` runs type-aware Oxlint once instead of preceding it with the same ordinary
  rules, and runs the web suite once with coverage instead of three overlapping executions.
- `cloudflare/test-shards.ts` uses refreshed relative scheduling weights. All discovered tests,
  including new files, remain assigned. Weights now use Linux run 36658908035.

Dependency-guard probes were already invoked only once by `lint:deps`; no probe was removed.
Public-boundary negative tests remain integration tests because rejection **and absence of
partial side effects** require actual storage. Pure schema/policy tests already have their own
portable seams; moving these negatives would remove evidence rather than optimize machinery.

## Reproduce

Run from `apps/server`:

```sh
bun --bun ../../node_modules/vitest/vitest.mjs run \
  --config cloudflare/vitest.config.ts \
  --reporter=json --outputFile=/tmp/cloudflare-results.json
```

For a scheduling check, add `--shard=1/4` (and repeat for the other three indices). Run the
shards sequentially when measuring on a workstation to avoid CPU contention. Measure elapsed
suite time from the JSON report's start time through the latest file end time; use per-file
start/end times for scheduling weights. Report failed tests rather than treating early failure
as a performance improvement.

For web verification, run from `apps/web`:

```sh
bun --bun ../../node_modules/vitest/vitest.mjs run --coverage
```

Use direct Bun invocation for these local measurements: the package-command invocation on this
workstation launched adapter workers without Bun globals. The runtime-invocation issue was not
changed as part of these performance optimizations.
