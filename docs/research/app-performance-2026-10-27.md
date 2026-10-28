# App performance assessment — October 27, 2026 (America/Bogota)

Status: baseline assessment and first targeted correction. Consent reads now retain declared rate-limit responses and can use bounded browser retries. No 10× improvement has been demonstrated. Measurements ran on October 28 UTC against revision `8ecd5e04d68525dbb203ef30631b4c53732a155d`, with the opt-in assessment fixtures in this working tree.

## Findings

1. **Normal navigation can overwhelm the application's own request admission policy.** A User shares two concurrent requests and a burst of ten, replenished at one request per second (`apps/server/cloudflare/canonical-admission/contract.ts`). Pages launch profile, category, workspace and review requests together. The measured journeys encounter repeated HTTP 429 responses, including `/web/consent`. Some returns to Transactions never regain usable controls within the readiness window. Budget return samples include approximately 1.4 s, 5.9 s and an unsuccessful 20 s readiness check. This is observable with the small account; it is not solely a large-database problem.

2. **Cached visibility substantially understates the wait for usable controls.** All eleven existing admission/performance checks passed. Their warm content measurements were: Budgets median 7.0 ms, Recurring 4.8 ms, Dashboard 6.7 ms, review returns 7.1/9.1 ms, review tab switching 11 ms, and Transactions 75.1 ms (one sample). Those tests intentionally allow data refresh to remain pending. In the heavy account's constrained-mobile run, Transactions returns took 3.85–4.13 s; Recurring returns took 5.97–13.54 s using the assessment's named-control readiness criteria.

3. **Recurring becomes unavailable at the extreme revision history.** At 100 plans × 100 revisions, neither desktop nor constrained mobile reached the target control within the readiness window. At 100 × 12 revisions, mobile also had a failed cold-readiness sample and slow repeat visits. The browser's canonical response limit is 1 MiB with a 15-second deadline (`apps/web/src/transport/browser-http-policy.ts`); an independent authenticated read returned HTTP 200 with **2,709,852 bytes**, 2.58× the browser limit. Returning the whole revision history therefore exceeds the browser’s supported response size at this valid domain cap. Do not interpret HTTP 200 alone as successful browser decoding or rendering.

4. **Seeded pending budget evaluations block Transaction corrections.** The heavy seed creates four distinct pending budget-evaluation timestamps. Canonical mutation preflight drains one per call and returns 503 while any remain (`canonical-operations/operations.ts`, `budgets/operations.ts`). An isolated native reproduction observed pending counts 4/3/2/1 and HTTP 503/503/503/200; the Transaction stayed at revision 0 on refusals and changed to revision 1 only on the successful call. Repeating the stale revision then returned 400. The identical small control succeeded, and direct correction SQL on heavy data succeeded. This identifies pending-work preflight, not a generic large-history SQL failure. The fixture leaves this work pending; the baseline therefore includes backlog pressure. A settled-account comparison should drain work through the real evaluator during setup and preserve backlog as a separate scenario. No production mutation retry or drain-limit increase was added.

5. **Cold delivery and browser work matter on slower devices.** Constrained-mobile cold workspace results are commonly 8–11 s, with observed long tasks reaching hundreds of milliseconds. The built artifact contains 2,064,978 bytes of JavaScript across all chunks (approximately 660,360 bytes if gzip-compressed individually). The largest chunk is Dashboard: 483,467 bytes raw / 144,146 gzip. This is total artifact size, not the amount every route necessarily downloads. The local preview serves uncompressed assets; these network-constrained results are not estimates of Cloudflare edge performance.

## Measured readiness

Heavy account, production build, cold document loads (seconds; one sample each):

| Workspace    | Desktop |      Constrained mobile |
| ------------ | ------: | ----------------------: |
| Transactions |    0.63 |                   11.12 |
| Budgets      |    1.49 |                    9.88 |
| Recurring    |    1.02 | Failed readiness window |
| Dashboard    |    4.06 |                   10.93 |
| Needs Review |    4.06 |                    9.88 |
| Account      |    0.26 |                    7.23 |
| Access       |    1.56 |                    8.29 |
| Upgrade      |    2.50 |                    9.09 |
| Privacy      |    0.30 |                    7.62 |

The heavy development-build desktop run also reproduced the Transactions return failure, correction failure, and a Budget return failure. Its cold Transactions/Budgets/Recurring observations were 1.43/2.38/1.87 seconds. These are single diagnostic observations, not a reliable development-versus-production speed ratio.

See the [durable measurement summary](app-performance-measurements-2026-10-27.json) for every recorded journey, completion status, request status/endpoint counts, response sizes and long-task observations. Raw request counts vary with completed journeys and must not be compared as equivalent tier workloads.

## Dataset and execution

| Dataset | Transactions | Budgets | Recurring plans × revisions | Pending review items |
| ------- | -----------: | ------: | --------------------------: | -------------------: |
| Small   |          500 |      16 |                      10 × 1 |                   50 |
| Heavy   |       10,000 |      64 |                    100 × 12 |                1,000 |
| Extreme |      100,000 |     128 |                   100 × 100 |                5,000 |

Transactions include a recent concentration plus a ten-year history. Budget categories/currencies are distinct; the extreme tier reaches the current Budget, Recurring plan/revision and retained statement-review caps. SQL constraints and projection triggers remain enabled. Seeding is confined to `isolatedTestStorage()` through the existing browser acceptance process. Review originals are synthetic inline text; this is not a statement ingestion, large-media or R2-throughput benchmark. No production data was seeded.

The harness also supports a bounded `breaking` tier of one million Transactions. The measured ladder already encountered failures before this tier; it has not established an exact minimum failing record count. Plans, revisions and review rows are not pushed beyond valid domain caps merely to produce invalid data.

The browser was installed Chromium 154.0.8037.57 on Linux x86_64. The repository-pinned Chromium 156 download was blocked by network policy. The workspace reports five processors; this is a container benchmark, not a physical phone.

- Desktop: ordinary browser CPU and loopback network.
- Constrained mobile: 390 × 844 viewport, 4× CPU slowdown, 150 ms network latency, 200,000 bytes/s downstream and 93,750 bytes/s upstream. This emulates constraints; it does not establish real mobile browser/device behavior.
- Production-mode Vite build; local public/Core/native SQLite acceptance topology and synthetic external providers. No authenticated production services were exercised.
- Real browser clocks, real authentication redemption, no mocked financial API responses, serial journeys and zero test retries. Existing rate limits, timeouts and authorization checks remain active.
- Development-server comparison: desktop only, with hot reload disabled. The Bun/HTTPS HMR websocket crashed in this environment; the opt-in benchmark disables that websocket while retaining Vite's development compilation. This is a benchmark environment limitation, not proof that the user's normal development server has the same failure.

## Coverage and interpretation

The assessment visits Transactions, Budgets, Recurring, Dashboard, Needs Review, Account, Access, Upgrade and Privacy. It measures cold document loads, up to three repeat workspace returns, month changes, transaction pagination/editor/save, and review original/autosave/filter/pagination. Failed prerequisites prevent dependent actions; omitted samples are unmeasured, not successful.

Cold samples clear the browser HTTP cache and create a new document but retain the account's server state, admission pressure and database caches. They are **not idle-server cold starts**. Repeat visits deliberately follow each other quickly. The same seeded User is used for sequential profiles, so mutations and Dashboard initialization can carry into the second profile. Initial pilot runs reused unchanged save values; no-request save observations must not be treated as write latency. The retained harness alternates values to require an actual change.

Elapsed time starts before the Playwright action and ends after a named readiness assertion plus two animation-frame opportunities. It includes automation overhead. A visible/enabled named control does not prove every control or every underlying refresh is complete; for example, Dashboard customization can be reachable while its catalog refreshes. Review form visibility and original-material visibility are measured separately. The existing sub-frame navigation gates use a different observer and must not be numerically compared as if they were this metric.

Readiness normally has a 20-second limit; cold document navigation can add time before that assertion begins. Failure durations are censored observation windows, not completed response times. Browser long tasks are observed with PerformanceObserver. Loading indicators are sampled after the triggering action; zero observations does not prove zero loading frames. `-1` means an unavailable measurement. Per-request size/timing collection is bounded; requests still in progress may remain unknown. Resource Timing byte totals exclude cross-origin bytes not exposed by the browser.

Only one cold sample per route/profile/tier and at most three repeat samples were collected. These are diagnostic experiments, not statistically reliable population medians or p95s. The runner's “passed” status means it collected observations; unavailable samples remain failures in the report.

Not yet measured: a hosted deployment, real provider latency, physical phones, every financial mutation, full new-user onboarding, AI response/streaming latency, payment completion, OAuth/CLI approval flows, large file/media processing, prolonged scrolling, expired-cache returns, and concurrent users/tabs. No claim of complete app-wide coverage or deployment equivalence is made.

## First correction and remeasurement

The Consent adapter had been replacing an authenticated read's admission refusal with a generic `consent_unavailable` response, discarding both the declared rate-limit body and `Retry-After`. The corrected GET boundary preserves that safe refusal with `Cache-Control: no-store`; its declaration now includes `ResourceLimited`. Browser GET/HEAD authentication reads use the existing bounded refusal retry policy inside their original deadline. Consent remains authoritative: no cached grant bypass or mutation replay was introduced.

A production-build heavy desktop rerun used the same seed and browser profile. The first Transactions return changed from **unavailable after the 20-second readiness window** to **ready in 7.13 seconds**. Two additional returns completed in **7.08 and 8.09 seconds**; the baseline had skipped those after its first failure. This is a demonstrated recovery improvement, not a latency multiplier: a failed baseline is not a completed 20-second interaction. The continuing 7–8-second waits do not meet the user's goal. Budgets and Recurring still had failed readiness samples, and the pending-budget-work correction refusal remained.

Only heavy desktop was remeasured after this correction. Other tiers, constrained mobile and development remain baseline evidence. Later route timings are affected by the newly completed earlier journeys, so they do not provide controlled per-route before/after comparisons. Raw corrected observations are in `assessment-heavy-after.json` and the durable summary. A browser-only retry experiment without the server correction did not recover the Transactions return; that intermediate raw run is retained as `assessment-heavy-client-retry-only.json`.

## Remaining improvement order and acceptance

1. Separate settled-account measurements from the confirmed pending-budget-work scenario; evaluate background draining and recovery without replaying uncertain mutations or merely raising the one-item preflight bound.
2. Trace and deduplicate navigation/focus refreshes, especially retained Review/Recurring queries and profile/category requests. Align browser request coordination with the shared admission envelope. Keep authoritative mutation, Consent and session checks; increasing limits or hiding error/loading UI alone would not establish the requested outcome.
3. Bound Recurring display payloads independently of accumulated revision history. Preserve full history through an explicit bounded path; keep server-owned financial calculations and write revision checks.
4. Measure the critical route dependency chain, split expensive startup work, and verify compressed immutable asset delivery on the dedicated deployment. Profile the long tasks before choosing rendering/virtualization changes.
5. Extend the harness to the remaining flows and acquire repeated, comparable before/after samples. Keep dataset, browser, network/CPU profile, readiness criterion and admission conditions fixed. Treat successful completion rate as a prerequisite for latency comparisons.

Use 10× as a per-journey target where the baseline permits it: for example, a 4 s repeat interaction should reach 400 ms or less under the same conditions. Do not average a fast route with a failing route or claim a universal multiplier from a changed fixture. The user's goal remains no spinners, skeletons or waits; first visits and server-confirmed actions need architectural work, and removing their feedback cannot demonstrate zero elapsed time.

## Reproduction and evidence

From `apps/web`, with repository dependencies and a compatible Chromium installed:

```bash
FIDY_ASSESSMENT=heavy ASSESSMENT_CHROMIUM=/usr/bin/chromium \
  bun --bun playwright test --config playwright.assessment.config.ts
```

Use `small`, `heavy` or `extreme` for the measured tiers. Omit `ASSESSMENT_CHROMIUM` to use Playwright's installed pinned browser. Set `FIDY_ASSESSMENT_BUILD=development` for the Vite development server. Run one invocation at a time because the fixture uses fixed loopback ports. Without `FIDY_ASSESSMENT`, the configuration preserves the original projects; select `--project=performance` for the existing gates.

Raw reports are written outside Playwright's cleaned output directory to `reports/performance/assessment-*.json`. They contain the `assessment-samples` attachments and are locally retained, gitignored artifacts. The assessment configuration is opt-in; the normal CI performance thresholds are unchanged. The compact measurement summary next to this document preserves the measured results for review. Original heavy baseline raw evidence is preserved as `assessment-heavy-before.json`; subsequent experiments are separate runs.

Hosted validation remains pending: the workspace has no configured deployment credentials. The user's choice to use any suitable test environment does not provide those credentials.

Validation: the existing eleven browser admission/performance checks passed; the assessment runs recorded observations for all three tiers and development desktop, and the independent response-size probe completed. The focused transport suite passed 40 tests and the native Consent suite passed 25 tests, including declared-refusal recovery. TypeScript build, targeted lint, contract freshness, and web/server dependency checks passed. Assessment-run success is evidence of collection, not evidence that failed journeys meet a performance budget.
