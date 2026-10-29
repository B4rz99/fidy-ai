# Desktop startup performance — 2026-10-29

The universal desktop 2× target remains unmet. This is an in-progress checkpoint; final matched
measurements are pending. The latest complete browser run passed 365 cases with three skips. A
new late-Review-response regression and four related freshness/retention checks also pass. Issue #1593 remains open.

The user narrowed the target to desktop. The assessment now runs desktop only, with a 1280 × 720
viewport, normal CPU and unthrottled network. Previously collected mobile observations remain
historical. Existing functional layout coverage is retained.

## Changes under validation

- Transactions requests 25 initial records and retains the existing 100-record continuation. Its
  summaries still describe loaded records. Real Core/D1 coverage verifies records beyond the first
  page, correction, confirmed deletion, and reload.
- Navigation requests Review counts with a zero-record window. For 1,000 pending records, the
  logical body is 64 bytes instead of 11,863 bytes for the default 50-record window. This is a payload
  reduction, not a claim of 185× faster application readiness.
- Consent combines expected binding with its live session discovery, removing one duplicate
  discovery query. Protected SQL still rechecks live authority. Native integration coverage observes
  two discovery queries before the change and one afterward, and rejects missing, foreign and
  revoked binding/session cases.
- The router reuses the immutable binding already latched at the application boundary for display
  classification. Protected requests retain their bound header and lifetime cancellation.
- Query owners remain mounted while Transactions and Dashboard presentation loads. Read-only
  history owns its query outside presentation suspension. Its navigation count shares the page's
  fresh Consent query before mounting ordinary reads, preserving access after withdrawal and reload.
- Review navigation loads independently of the retained editor. Routes preload both inner Review
  wrappers before committing, while the application imports the public facade lazily. The bundle
  gate rejects Review or Dashboard dependencies in the public/auth initial load.
- Poppins uses Latin subsets and retains original coverage for other scripts. The logo is an exact
  lossless WebP conversion. Sidebar artwork uses density-specific variants; its larger access-screen
  composition retains the originals. Regeneration instructions accompany the assets.

## Measurement and regression diagnosis

Matched cold observations use the same compressed preview, empty HTTP cache, native control
observer, fixed dataset and twelve-second admission refill outside the measured interval. Gzip is
measurement methodology: production already compresses assets. Compression itself is not counted
as a product gain. Rapid navigation remains separate from isolated startup.

The first corrected desktop comparison records 33 successful observations on both unchanged trunk
and the candidate: 27 cold documents and six immediate capture/calendar openings. That candidate
checkpoint improved Transactions from 482 ms to 338 ms but regressed Access, Upgrade and Privacy.
It predates later startup changes and is not final-head evidence. See the accompanying measurement
JSON for complete arrays and failure counts.

Investigation found the public Review facade was statically imported by the route table, pulling
navigation badge dependencies into every initial page. Restoring the lazy boundary reduced the
observed initial compressed JavaScript from roughly 260 KB to 235 KB. Both Review wrappers still
preload, and original return/freshness assertions pass. Experimental common-chunk inlining and
route-wide asset hints were removed while concentrating on desktop.

Privacy timing remains variable. Separate diagnostic runs measured server processing and browser
transport; these exploratory observations are not substituted for a final matched matrix. Five
subsequent Privacy observations were all ready, with a 248 ms descriptive median. No universal
speedup is inferred from that focused run.

## Validation checkpoint

319 web unit tests and 77 focused session/Consent/admission tests pass. Lint, both application type
checks, policy integrity, dependency boundaries and the browser bundle gate pass. The complete
browser rerun passed 364 cases, with three existing skips and no failures.

Earlier complete runs are retained: 360 passed / four failed / three skipped, then 362 passed /
two failed / three skipped. Fixes preserve the assertions and deadlines:

- Isolated fixture sockets bridge exact shared-fixture URL/Host coordinates and callback locations;
  production origin policy remains unchanged.
- Read-only history's owner remains mounted outside lazy presentation.
- Upgrade text reflow uses an independent unpaid User after an earlier payment journey upgraded the
  shared User to Pro.
- Email cooldown tests settle each intercepted poll before advancing virtual time across its HTTP
  deadline. The original cooldown checks pass three consecutive runs.
- A real Core journey now reloads withdrawn-Consent history and requires the read-only view.

## Production and remaining coverage

The authenticated production Transactions baseline served revision
`7cb76cd8f7c34b0639e98af5c05085142cf3521c`. Three desktop observations had a 3,423 ms median.
The production baseline JSON records raw numeric timings, exclusions and restored browser settings.
Its User has a different dataset from the local heavy fixture; the two are not a speedup comparison.

Remaining work includes final desktop cold/rapid comparisons, extreme and million-Transaction
coverage, authenticated production coverage across workspaces, required CI, and post-deployment
remeasurement. Live bank/payment/email/AI provider timings require isolated sandbox access and have
not been measured. No real provider charge, financial mutation, credential grant or message was
performed for this assessment.

Raw local evidence remains under ignored `reports/performance/startup-2026-10-29/`. The durable
[measurement checkpoint](app-performance-startup-measurements-2026-10-29.json) preserves desktop
sample arrays and scope limitations. The [production baseline](app-performance-production-baseline-2026-10-29.json)
is a separate workload.

## Desktop pressure diagnostic after trunk sync

All five heavy assessment cases completed on base `90bdfb2aae31a4ca952ca021103a8fbfbb8fb6fc`.
All 65 readiness observations completed. System activity and another checkout’s type-aware lint
were observed during the run, so these timings are diagnostic and do not establish matched speedups.

Transactions warm returns measured 3,426 / 6,448 / 3,388 ms. Their request logs show Review list,
detail and material reads continuing alongside the returning Transactions Consent read, with repeated
429 responses before recovery. A regression test now gates an inbox response until after leaving
Review and checks that an editor never displayed there does not start detail/material reads. The
test failed with one hidden detail read and one hidden material read, then passed after deferring
an editor that has never been displayed. Four related checks also pass. Already displayed editors
remain mounted on later navigation. Existing draft freshness,
original retention and admission thresholds remain required.

## Required patch refresh

The dependency gate required Effect family 4.0.6 and React Router 1.170.46 after their existing
seven-day admission age elapsed. Eleven changed locked identities match the npm registry integrity.
The stricter JSON types exposed three MCP boundary sites: unknown-input decoders now validate
continuation/output data, and optional retry metadata is decoded as JSON before typed admission
encoding. Authorization, confirmation and admission rules remain in place.

After the refresh, 319 web unit tests and 280 focused native tests pass, with one existing native
skip. The earlier 364-case browser result predates this refresh; the refreshed full browser run passed 365 cases with three skips. Final latency measurements use
the refreshed dependency graph.

## Refreshed desktop heavy results

All five assessment cases pass, and all 65 readiness observations complete. The cold matrix has
three completed observations per workspace. The other checkout held off new heavy checks during
the coordinated window; 20-second host snapshots are retained, without claiming complete host isolation.

| Workspace    | Baseline driver / native median (ms) | Candidate driver / native median (ms) |
| ------------ | -----------------------------------: | ------------------------------------: |
| transactions |                            482 / 422 |                             299 / 242 |
| budgets      |                            344 / 304 |                             391 / 306 |
| recurring    |                            465 / 415 |                             972 / 478 |
| dashboard    |                            395 / 341 |                             385 / 346 |
| review       |                            379 / 316 |                             323 / 249 |
| account      |                            230 / 160 |                             191 / 150 |
| access       |                            268 / 200 |                             260 / 206 |
| upgrade      |                            252 / 226 |                             222 / 181 |
| privacy      |                            238 / 175 |                             209 / 149 |

Transactions improves from 482 to 299 ms in the driver median, and from 422 to 242 ms in the
browser-native control median. Neither demonstrates 2×. Several other pages remain near baseline,
and Recurring remains slower. Its driver median (972 ms) differs substantially from its native
control median (478 ms); driver readiness includes automation/assertion timing. Do not treat that
gap as application processing or substitute one metric for the other.

The baseline is the corrected 7cb76cd measurement; the candidate includes two subsequent ingestion
fixes, the startup changes and the required patch refresh. Three observations are descriptive, not
confidence intervals. Full arrays and completion counts are in the JSON. The universal target
remains unmet.

## Recurring conversion investigation and latest desktop pass

A deterministic test with 100 plans and two time zones reproduced 100 date conversions for one
Transaction. The projection now converts each Transaction once per distinct time zone within that
single read, preserving match results and allocation order. Nothing is retained across reads.
The test failed with 100 conversions before the fix and passes with at most two afterward;
22 focused native tests pass, with one existing skip.

The first focused three-sample comparison measured driver/native medians of 561/512 ms before
and 486/440 ms afterward. One after sample overlapped another checkout's already-running workflow;
it remains in the results. The subsequent complete heavy desktop run passed all five cases and
all 65 readiness observations. Recurring measured 514/426 ms, versus 465/415 ms in the original
baseline. This removes repeated conversion work but does **not** prove the page regression resolved
or the app-wide 2× target achieved. Full samples and all other routes are in the companion JSON.
Static verification and the production web build pass on this source.

The 100,000-Transaction tier previously completed all five cases and 43 readiness observations.
The million-Transaction tier has no application observations: initial startup failed in the native
D1 fixture transport; separate 120-second seed probes timed out; moving data population to the
assessment's existing 600-second beforeAll budget also timed out. Preparation runs before any page
measurement. Existing test deadlines and page thresholds remain unchanged, and native constraints
and triggers remain enabled. These are preparation failures, not million-record page latencies.

## Production sign-in availability

At 2026-10-29 18:23 America/Bogota, the production app could not restore usable Transactions
controls. A fresh sign-in attempt returned HTTP 503 with `{"status":"unavailable"}` from
`/web/pairings`, before reaching Google. API health still reported `available` on revision
`90bdfb2aae31a4ca952ca021103a8fbfbb8fb6fc`; that health handler validates release configuration
and does not prove database availability. No new production latency sample is claimed.

The user suggested D1 quota exhaustion. Cloudflare documents free-tier daily read/write failures
until midnight UTC (19:00 Bogotá), but account usage has not been verified. See
[Cloudflare's quota enforcement documentation](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

## Committed-head extreme validation and CI compatibility

On runtime source `d159e87324d64963f24261f92f1e0447cbea7159`, the 100,000-Transaction
assessment again passes all five cases and all 43 readiness observations. This run has one
isolated cold observation per page; it supplies no matched-baseline speedup ratios. Recurring
measures 437/368 ms (driver/native). All nine cold arrays and the rapid-navigation results,
including multi-second admission contention, remain in the companion JSON.

Initial PR CI found three tests comparing complete internal Exit objects against fresh failures.
The required Effect patch adds trace annotations to named effects. The tests now require exactly
one Fail reason and the same typed domain error, without comparing incidental trace metadata.
The original 15,000-byte ASCII/UTF-8 boundaries, privacy checks and absence-of-staging/sending
assertions remain. Three memory tests and all four governor tests pass locally after the change.

The read-only production traffic inspection
[40974767949](https://github.com/B4rz99/fidy-ai/actions/runs/40974767949) succeeds and reports no
topology drift. It requested neither a database proof nor sandbox-provider authentication, and
made no traffic change. It does not establish D1 availability or confirm quota exhaustion.
