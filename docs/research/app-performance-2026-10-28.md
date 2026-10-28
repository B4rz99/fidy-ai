# Web application performance assessment — 2026-10-28

The universal 2× and zero-loading targets have **not been achieved**. This change fixes measured bottlenecks and preserves the remaining failures and coverage gaps. There is no defensible single application-wide improvement percentage.

## Scope and evidence

The initial complete browser inventory contained 370 scenarios in 52 files: 364 passed, three failed during Consent recovery and three were skipped. After integration with trunk's review refactor, the inventory contains 365 scenarios. The complete integrated run passed 359, failed three and skipped three. Focused validation after correcting retained-workspace freshness passed all three previously failing scenarios; the Upgrade failure did not recur in that isolated check. Existing performance assertions retain their thresholds. The first integrated Review return failed at 24.3 ms against 16 ms; stabilizing the edit callback and avoiding hidden-field disabled-state churn made the next complete run pass its performance gates. The original failure remains recorded.

Final focused checks passed 300 web unit tests and 77 server integration tests, with one server test skipped. Repository static verification passed, including types, boundaries, contracts and security-policy integrity.

Full-suite durations include authentication, fixtures, controlled clocks, intentionally held responses and assertions. They are functional coverage and diagnostic timings, not user-readiness latency.

The readiness harness measures Transactions, Budgets, Recurring, Dashboard, Needs Review, Account, Access, Upgrade and Privacy; cold documents, repeated returns, filters, pagination, editor opening, transaction correction, previous month, original material and autosave. It records successful readiness, unavailable/time-limited samples, observed loading states, API responses, bytes, long tasks and DOM/resource counts. Optional actions can be skipped when an earlier state is unavailable. This is not every possible application state or API endpoint.

Heavy data contains 10,000 Transactions, 64 Budgets, 100 RecurringPlans with 12 revisions each and 1,000 review items. Extreme data contains 100,000 Transactions, 128 Budgets, 100 plans with 100 revisions and 5,000 review items. These are synthetic isolated local data. The million-Transaction breaking tier is available but has not been measured.

Desktop uses the installed Chromium 154. Constrained mobile uses 390×844, fourfold CPU slowdown, 150 ms network latency, 200,000 bytes/s download and 93,750 bytes/s upload. Before and after use the same browser and profiles. Readiness includes driver/assertion overhead and two animation frames. Small sample counts and a shared host do not establish production percentiles.

## Changes

- Compact Recurring display responses retain only each plan's latest revision. Storage and historical calculations retain the complete ledger; the API's default full response remains available. Browser reads and edit receipts explicitly request the compact projection.
- Browser clients share two in-flight request permits within their authentication lifetime. Queue time remains inside the original deadline; logout cancels queued work. Declared Consent GET pressure responses preserve their typed 429 and Retry-After for bounded safe retries.
- Ordinary display queries reuse five-second snapshots. Explicit invalidation still refreshes; Review revalidates on every return so another device's saved draft is observed. Retained Recurring refresh timing uses wall time so crossing midnight still updates the default month. Security and Consent reads remain fresh.
- Unvisited review history panels do not fetch. Hidden review panels suspend their own periodic/focus subscriptions. Categories share the normal display snapshot. Stable editor callbacks preserve memoized controls; hidden/inert containers prevent interaction without toggling every field's disabled state.
- Same-month budget invalidation timestamps are coalesced into one financial-month evaluation, with a bounded 128-row snapshot and version-checked deletion. Distinct months remain separate. Tests retain reached thresholds and prove that concurrent version changes remain pending. This restores corrections previously refused while the seeded backlog drained across multiple attempts.
- Review autosave begins after 200 ms of idle input. Subsequent automatic writes are spaced by at least one second; explicit decisions flush through the serialized owner. Saved feedback still requires acknowledgment.
- Lossless WebP encoding reduces shared artwork from 2,700,052 to 1,535,162 bytes, saving 43.1%. Alpha and visible pixels were verified unchanged; source PNGs remain. Exact money formatter reuse is bounded to 32 configurations and stores no financial values. A 10,000-format local batch improved from a 298 ms median to 54 ms; precision tests pass. That microbenchmark is not a page-latency multiplier.

## Final integrated heavy verification

Three return actions per workspace/profile in the final run are compared with the successful observations across three baseline runs. These are descriptive medians, not statistical confidence intervals. Baseline unavailable samples are excluded from latency and remain failures in the data; the Budget baseline includes three failed return checks. Final rapid navigation reached readiness for every attempted action in both profiles.

| Return workflow | Desktop before → final | Constrained mobile before → final |
| --------------- | ---------------------: | --------------------------------: |
| Transactions    |       7,091 → 3,378 ms |                  3,759 → 1,262 ms |
| Budgets         |          3,692 → 88 ms |                    2,352 → 843 ms |
| Recurring       |           544 → 218 ms |                  8,528 → 2,178 ms |

The extreme full response measured 2,709,852 bytes; the compact browser projection measured 127,932 bytes, a 95.3% reduction (21.2× smaller). All three extreme assessment cases passed. Heavy and extreme readiness observations remain separate in the data.

## Interpretation and remaining work

Repeated development iterations substantially improved warm Transactions, Budget and Recurring readiness, and restored stressed writes. Those exploratory runs precede the final freshness corrections and upstream integration; their exact per-run measurements are preserved rather than presented as final-head universal speedups. Final integrated heavy/extreme observations are recorded separately in the accompanying data.

Cold mobile pages still require several seconds. Dashboard, filtering, pagination and editor-opening measurements have not demonstrated a consistent 2× improvement. Some later desktop cold pages become slower in the rapid sequence when faster earlier actions leave less admission allowance to refill. An additional baseline isolates cold documents by stopping the previous document and waiting twelve seconds outside the measurement for the unchanged allowance to refill. This distinguishes contention from startup delivery; it does not erase the rapid-sequence result.

No deployment credentials or outbound provider identity are configured. Hosted latency, real bank/payment/email/AI provider timings and production load behavior remain unmeasured. Browser provider fixtures do not prove live-provider performance. Further work is required on cold dependency delivery, reducing remaining redundant reads and original-material recovery. Removing loading feedback would not demonstrate that the underlying work became instantaneous.

## Reproduction

From `apps/web`, run one browser invocation at a time:

```bash
FIDY_ASSESSMENT=heavy ASSESSMENT_CHROMIUM=/usr/bin/chromium \
  bun --bun playwright test --config playwright.assessment.config.ts
```

Choose `small`, `heavy` or `extreme`; use `--grep 'assesses all'` for rapid navigation, `--grep 'isolated cold'` for isolated startup and `--grep 'measures the recurring'` for full/compact payload size. `FIDY_ASSESSMENT_BUILD=development` selects the separate development server. Omit the dataset to retain normal browser projects. The complete-suite diagnostic reporter is `scripts/performance-reporter.ts`, configured through `FIDY_PERFORMANCE_OUTPUT`.

Durable observations: [measurement data](app-performance-measurements-2026-10-28.json), [baseline scenario inventory](app-performance-coverage-2026-10-28.json), and [first assessment](app-performance-2026-10-27.md). Raw local Playwright reports remain under ignored `reports/performance/round-two/`. Dataset, stage, failure counts and successful-only timings remain separate. Failed baselines receive no speedup ratio.
