# CI follow-up: #922–#926

## Status and measurement boundaries

This is **local evidence, one Linux validation sample, and measurement tooling—not completion of
the repeated Linux acceptance criteria**.
The available successful Linux runs use different revisions. In particular, do not pool runs
36658908035 and 36659691624 into a same-revision median. No scheduling weights have been refreshed
from those incompatible samples. The issues remain open pending controlled Linux confirmation.

Baseline source: `ba60765241c58da9ab258c39c1237523739eaaa0`. Local follow-up measurements were collected
before the first follow-up commit, on macOS arm64, Bun 1.4.1, Vitest 5.0.1, Playwright 1.63.0, Node 26.5.0,
and warmed dependency/browser caches. They are not measurements on GitHub's Linux runners.
The dependency-age gate also required rolldown 1.2.9 → 1.2.10 and React Router
1.170.38 → 1.170.39; these patch upgrades are a confounder for whole-gate/browser comparisons.
After the UTC date boundary, the gate additionally required development-only Workers types
5.20260923.1 → 5.20260924.1 in server and infrastructure. No release-age exemptions were added.

### Existing Linux baseline

[Run 36659691624](https://github.com/B4rz99/fidy-ai/actions/runs/36659691624):

- Workspace Gate: job timestamps span 105s, but validation is only 46s. Runner setup begins
  about 37s after the job's reported start. Checkout/base fetch, Bun setup, and Node setup then
  occupy approximately 20s. Do not attribute the full 105s to validation.
- Validation log boundaries attribute approximately 13.25s to type-aware lint (including guard
  probes and plugin tests), 7.28s to formatting, 9.36s to the project-reference build, 8.24s to
  the module graph/architecture probes, and 2.46s to dependency policy. Remaining checks account
  for the rest. These are adjacent-log timestamp estimates, not repeated phase benchmarks.
- Browser: complete job 88s, Bun setup 16s, browser-cache restoration 3s, combined browser/system
  installation 12s, validation 48s. The combined installation step cannot distinguish system
  dependencies from binary work; new separate steps will provide that distinction.
- Adapter suite elapsed times: 68.81s, 62.50s, 48.51s, 82.60s; spread 34.09s. These include
  imports/startup and differ from both summed file costs and complete job durations.

### First Linux PR validation sample

[Run 36806656514](https://github.com/B4rz99/fidy-ai/actions/runs/36806656514), PR #927,
revision `8bd45b833efb24590cb92e7fd61d82f3fd2d0fd7`: all functional checks, Secrets, and SAST passed.
SCA blocked the required aggregate on pre-existing brace-expansion and fast-uri advisories. The
follow-up pins brace-expansion 5.0.12 in the root and mutation-tool installs and fast-uri 3.1.8 in
root overrides. Their npm publication dates are September 14 and 15 respectively: both satisfy the
unchanged seven-day delay. No scanner exclusion or accepted-vulnerability exception was added.

| Linux observation           |                                Historical baseline |                    First PR run |
| --------------------------- | -------------------------------------------------: | ------------------------------: |
| Workspace Gate complete job |                                               105s |                             73s |
| Static validation           |             approximately 46s from step timestamps |       39.950s from phase report |
| Type-aware lint phase       |           approximately 13.25s from log boundaries |        9.358s from phase report |
| Browser complete job        |                           88s (warm browser cache) | 102s (cold new shell cache key) |
| Browser validation          |             approximately 48s from step timestamps |       46.561s from phase report |
| Mocked slowdown test        | no exact historical Linux per-test sample retained |                          0.597s |

The browser report records 37 expected tests, zero unexpected/skipped/flaky tests, and no retries.
This is **not** evidence that every job or end-to-end CI is faster: the first browser job was slower,
and runner/setup/cache differences and dependency patches prevent a controlled percentage claim.
Do not pool this revision with the later SCA-fix revision into a same-revision median. All required
checks must pass on the final PR head before merge; repeated equivalent Linux measurements remain
follow-up work.

## #922: Workspace Gate

`scripts/verify.ts` now records every check's elapsed milliseconds and exit code, plus total
verification time, revision, platform/architecture, and CI run/attempt when available. Failed
checks still run through the complete selected group and produce the report before returning
failure. No validation result is cached. CI preserves static, adapter, and browser verification
reports; Actions step/job timestamps separately account for runner setup and cache transfer.

A local static profile attributed 6.90s of 22.76s validation to the lint phase (the largest phase),
4.38s to typechecking, 3.32s to the module graph, 3.08s to fresh dependency policy, and 2.76s to
formatting. The initial gate failed formatting of the new code and the two dependency-age updates
above; it is not a successful-gate performance result.

The focused optimization batches the thirteen lint guard probes into **one type-aware Oxlint
invocation**. Each probe still has its own filename, configuration override, and expected rule;
the clean shadowed-Record probe must still have no diagnostics. The report must account for all
thirteen files and the expected failing exit status. Ordinary and type-aware checks, JS plugin
RuleTester tests, handwritten-symbol scans, and cleanup remain intact.

| Probe command elapsed, seconds | Run 1 | Run 2 | Run 3 |
| ------------------------------ | ----: | ----: | ----: |
| Original per-probe invocation  |  2.27 |  2.14 |  2.16 |
| Batched invocation             |  0.47 |  0.28 |  0.27 |

Runs were serial, on the same workstation with warm caches. An earlier baseline/first-after pair
was 2.72s/0.65s. This measures the **probe command**, not whole-gate improvement. It removes repeated
lint-program construction, not evidence. Three final local static gates passed in
17.988s, 17.680s, and 23.073s. Their spread illustrates why the probe-command savings cannot be
translated into a stable whole-gate percentage. Linux repeats are still required.

Reproduce phase reports:

```sh
VERIFY_TIMING_REPORT=/tmp/verify-static.json bun run verify -- --group static
/usr/bin/time -p bun apps/server/scripts/check-lint-guards.ts
```

Compare the original script in the parent revision, running it at the same directory depth so its
`import.meta.url` roots stay correct. Run measurements serially, not alongside other verification.

## #923: adapter fixture investigation — no justified optimization yet

An uninstrumented baseline of the two complete files passed all 104 tests: statement ingestion
14.88s, hosted Turns 10.63s. Temporary monotonic counters bracketed acquisition (including async
Worker startup), schema installation, setup seeding, and suite/fresh-runtime disposal. They were
removed after the measurement. An instrumented run passed the same 104 tests:

| Seconds, accumulated across the file | Statement ingestion | Hosted Turns |
| ------------------------------------ | ------------------: | -----------: |
| Worker/storage acquisition           |               1.339 |        0.303 |
| Schema installation                  |              10.646 |        6.905 |
| Setup seeding                        |               0.309 |        0.562 |
| Disposal                             |               0.036 |        0.015 |
| Remaining test execution (residual)  |               3.076 |        3.193 |
| File elapsed                         |              15.371 |       10.962 |
| Independent setups                   |                  51 |           49 |

The residual subtracts the measured acquisition/schema/seed totals from summed test durations;
it includes assertions, behavior, and unbracketed fixture work, not an independently instrumented
business-only span. Disposal is outside those summed test durations. Instrumentation changes elapsed
time, so this table is attribution, **not a before/after speedup**.

Schema execution still dominates. Seeds are already small: additional batching of hosted-Turn
seed writes cannot address the dominant cost. Immutable migration text is already cached, and
ordinary schemas already execute in one D1 batch. Caching a combined SQL list would not eliminate
D1 schema execution. Reusing an installed mutable schema/database, omitting migrations, or sharing
native coordinator runtimes would weaken isolation, freshness, migration, or lifecycle evidence.
Those options were rejected. There is no fixture-code optimization in this follow-up and no claimed
gain. Repeated Linux attribution and a supported platform-level optimization remain open.

The final complete adapter suite passed all 512 tests in 95.42s; the shuffled-test run
(`--sequence.shuffle.tests --sequence.seed=922`) passed all 512 in 98.53s. The four serially measured
shards passed 116/110/117/169 tests in 23.01s/25.67s/21.66s/26.95s, respectively. Their 38 files cover
the same discovered suite exactly once. An intermediate 513-test run contained a temporary redundant
scheduling test; it is not final-revision evidence. These are macOS execution times, not Linux
improvement estimates, and the Workers-types update happened subsequently without runtime changes.

Reproduce the uninstrumented baseline from `apps/server`:

```sh
bun --bun ../../node_modules/vitest/vitest.mjs run --config cloudflare/vitest.config.ts \
  ingestion/statement-ingestion.test.ts agent/hosted-turn.test.ts \
  --reporter=json --outputFile=/tmp/adapter-fixtures.json
```

For attribution, bracket `databases.acquire()` / direct-or-bound storage acquisition, the complete
schema branch (including legacy inter-migration seeds), and the remainder of `setup()`. Measure pool
`afterAll` disposal and statement native-runtime `afterEach` disposal separately. Sum file test
`duration` values and subtract the bracketed setup phases for the residual. Remove these counters
before comparing uninstrumented elapsed times.

## #924: reproducible median refresh

`scripts/adapter-timings.ts` accepts at least three distinct, successful Linux run/attempt samples
with identical revision and test configuration, each containing all four Vitest shard reports.
It refuses failed/skipped/todo evidence, duplicate file assignment, missing samples, empty runs,
and invalid durations. File costs use `(endTime - startTime) / 1000`, not summed assertion durations.
The output is filename-sorted, with each median, all original samples, and min/max; noisy samples
are retained rather than silently discarded. For an even sample count, use the mean of the two
middle observations. Regression tests cover these contracts and discovery-order independence.

Input `runs.json` has this shape (repeat with at least three real samples):

```json
[
  {
    "runId": "<GitHub run ID>:<attempt>",
    "revision": "<tested checkout revision from verify-adapters.json>",
    "platform": "linux",
    "configuration": "bun=1.4.1;vitest=5.0.1;shards=4;serial-files;ubuntu-latest;x64",
    "reports": ["<replace with the four parsed Vitest JSON report objects>"]
  }
]
```

The `reports` example is explanatory, not executable input. Download each run/attempt's four
`cloudflare-adapter-timings-*` artifacts with
`gh run download <run-id> --pattern 'cloudflare-adapter-timings-*' --dir <run-id>-<attempt>`, preserve
them before rerunning (the CLI downloads current artifacts, not a selected historical attempt;
artifacts have seven-day retention), and verify revision/platform/shard metadata
against `verify-adapters.json` and the Actions job records. For each run, concatenate the four
**parsed report objects** into `reports`. Then:

```sh
bun scripts/adapter-timings.ts runs.json > median-adapter-timings.json
```

Refresh `estimatedSeconds` in `apps/server/cloudflare/test-shards.ts` from `file`/`seconds`, retaining
all observed files, then rerun scheduling regressions, the complete suite, all four shards, and
shuffled execution. Record repeated actual shard spread and maximum validation/job durations before
and after; predicted sums are not measured job improvements. Repeat after fixture/coverage changes.
No other ticket's implementation is needed to collect these samples.

An attempted conservative fallback of the largest measured file cost was **rejected**: on the
existing single-run file costs it predicts shard work of 51.95s/34.15s/43.38s/109.51s, worsening
balance by overestimating many previously unweighted small files. The existing scheduler and its
weights/fallback remain unchanged until equivalent multi-run evidence supports a refresh. Tests
now verify exact assignment for requested shard counts 1, 2, 3, 4, and 8.

## #925: browser installation

Playwright 1.63.0's installed `playwright-core/lib/coreBundle.js` confirms:

- `resolveBrowsers` with `shell: "only"` resolves `chromium-headless-shell` plus FFmpeg, omitting
  regular Chromium; it retains supported download fallbacks.
- Chromium `getExecutableName` selects `chromium-headless-shell` for headless launches with no
  explicit channel. The current config/tests have no headed, channel, or executable-path override.

This agrees with the [official browser installation documentation](https://playwright.dev/docs/browsers#chromium-headless-shell).
`playwright install --dry-run --only-shell chromium` confirms exactly those two binary targets.
The workstation has only the matching shell and FFmpeg installed; all 37 tests pass on that setup.
The option changes what is **downloaded**, not the browser executable previously used for validation.

CI now separates `install-deps chromium` from `install --only-shell chromium`, runs both even on
cache hits, logs cache-hit state, and preserves the verification report. The exact cache key retains
OS/architecture/installed Playwright version and adds the executable selection. A cache miss still
downloads the supported shell; a cache hit still repairs missing binaries. No system dependency,
freshness check, credential/session data, or diagnostic media is cached. Browser retries are zero.

Binary download savings on a cold Linux cache and cache transfer/system-dependency costs on warm
Linux caches still need repeated measurements. Do not infer those savings from local browser test
durations or the dry-run target list.

## #926: mocked slowdown

The mocked scenario now installs the browser clock, reaches its first poll, then pauses timer
execution. While its first request remains pending, advancing six seconds (past the normal polling
interval, below the request timeout) must not issue another poll or show terminal refusal. Only
then is the 429 fulfilled. `runFor(9999)` must not retry; the next millisecond must issue exactly
one second poll using the original pairing/verifier. It remains nonterminal until that request
returns the generic invalid-pairing response; advancing another ten seconds must produce no more
requests or replacement pairing. The exact request/response event order is asserted.

This uses actual timer execution (`runFor`), not `setSystemTime`, and is limited to the mocked case.
Dedicated sequential real-time cadence, real approval, support recovery, verified email, Core proof
validation, session creation, and platform rate limits remain unchanged.

| Local browser measurement                        |   Original |    After 1 |    After 2 |
| ------------------------------------------------ | ---------: | ---------: | ---------: |
| Mocked slowdown test                             |    15.637s |     0.519s |     0.492s |
| Complete 37-test browser/accessibility execution |    45.492s |    33.931s |    33.661s |
| Passed / skipped / retried                       | 37 / 0 / 0 | 37 / 0 / 0 | 37 / 0 / 0 |

These runs used Node's Playwright CLI, two existing workers, prebuilt static hosting, and a fresh real
Core fixture per full run. They exclude build/startup and complete-job time. A temporary copy replaced
loopback ports 4173–4175 with 4273–4275 (including CSP and fixture origin policy) because unrelated
stale test servers occupied the original ports. The first failed scratch attempts exposed incomplete
port substitution and were not treated as passing timing evidence. The dependency patches above
also separate the original and follow-up builds; this is not a controlled Linux percentage claim.

The acceptance evidence still needed is repeated Linux per-test and complete browser-validation
measurements, including cold/warm browser cache paths and runner variation, followed by required CI
checks on the exact final revision.

## Local validation summary

- Final Workspace Gate passed (including type-aware lint, formatting, typechecking, architecture
  guards, generated freshness, and uncached dependency policy).
- Builds passed, including the actual Worker document-parsing proof.
- Unit/artifact group passed: 366 core tests, 9 email-interpretation tests, 229 web tests with
  Istanbul coverage, 31 CI-tool tests, and 4 contract-checker tests.
- Cloudflare infrastructure: 151 tests passed.
- Adapters: all 512 tests passed unsharded and with shuffled tests; all four shards collectively
  assigned all 38 discovered files exactly once and passed the same 512 tests.
- Browser/accessibility: all 37 tests passed twice, zero skipped/flaky/retried cases, using the
  temporary isolated-port arrangement described above.
- The local results above precede PR creation. GitHub Actions validation for the committed changes
  is tracked in PR #927; its first Linux sample and SCA blocker are recorded above. Merge requires
  all checks to pass on the final head. Repeated equivalent Linux measurements are still pending;
  no issue is closed on the strength of local results or a single Linux sample alone.
