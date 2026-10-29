# Cold startup follow-up — 2026-10-28

The universal 2× and zero-loading targets remain unmet. This follow-up removes hidden artwork
requests, splits provider-return presentation, updates eligible dependencies blocking SCA, and
records the critical resource waterfall and direct Production observations. It does not establish
a universal readiness improvement.

## Delivery and API evidence

The previous constrained local result reproduces on macOS: cold Transactions took 10,797 ms.
The browser received the initial 227,276-byte entry, 238,878-byte React DOM/shared-button chunk,
and 187,868-byte client chunk without compression. They began around 175 ms; the largest completed
at 4,983 ms. Destination code began around 5,700 ms and the calendar-containing chunk finished
at 8,867 ms. Controls were ready at 10,797 ms. This sequence establishes a substantial delivery
waterfall; it does not assign every millisecond to transfer rather than overlapping execution.

The local preview serves identity-encoded files. Production returns compressed HTML (`gzip`) and
JavaScript (`zstd` observed in the in-app browser). Its hashed assets retain immutable caching;
HTML remains `no-cache`. Therefore local uncompressed timings cannot be presented as deployed
latency or as a precise model of Production delivery.

Production was reachable from this Mac. Both the live API and deployed release workflow identified
`67335840a1274c57b513dea6218e864e7d1cb912`. The public app request returned 200 in 501 ms and
API health returned 200 in 1,213 ms. These single requests include network overhead and are not
server-processing measurements or percentiles.

Using the existing signed-in in-app-browser session, a cache-bypassed Transactions document reached
its visible, enabled `+ Registrar` control at 9,919 ms on the normal connection. The observed
critical dependency sequence was:

```text
HTML response                       1,488 ms
initial document code ready         2,068 ms
session binding complete            2,702 ms
Consent complete                    4,533 ms
User profile complete               5,757 ms
Transactions refused with 429        7,024 ms
safe retry starts                   8,025 ms
Transactions succeeds               9,877 ms
enabled control observed            9,919 ms
```

A second session-binding read overlapped Consent. Categories and the navigation pending-count
read also overlapped other work. Preflights and network latency are included in request durations;
the browser observation does not separate D1, Durable Object queueing, server execution, and transit.
An earlier Dashboard request alone took 5,670 ms. Attributing all cold delay to assets or to the
database would both exceed the evidence.

Under the matched constrained-mobile profile, Production Transactions reached the control at
10,583 ms. Its closed navigation still requested 1,535,162 bytes of decorative artwork, with image
completion extending beyond control readiness. Cache bypass retained the existing browser process,
DNS and TLS connections; this is not a new-device network handshake measurement.

Production Budgets reached its enabled previous-month control at 6,683 ms. A cold Recurring attempt
displayed access refusal and did not produce a valid readiness sample. A later warm Recurring visit
rendered the main workspace, but Categories returned two 429 responses before success, and recurring
suggestions returned 429 followed by 503. Those failures remain part of the evidence, with no speedup
ratio. The existing signed-in account was not replaced or seeded; no financial writes, payment
authorization, or customer messages were submitted through the browser.

## Retained changes and rejected experiment

- Native lazy loading keeps the 1,109,578-byte habitat and 425,584-byte mascot out of a closed mobile
  navigation menu. Opening navigation still requests both. The behavioral browser regression failed
  before the change and passed afterward. Desktop artwork remains eligible to load when visible.
- Google and Microsoft return pages share an on-demand route component instead of eagerly pulling
  authentication presentation and styles into every startup. Their proof, completion, and session
  ownership remain with the existing provider-authentication feature.
- Assessment samples now retain resource start/response/end times, initiators, and encoded/decoded
  body sizes. Captured paths omit queries and normalize fixture UUIDs. The assessment can use the
  existing validated acceptance topologies, including a separate loopback port set when another
  checkout owns the shared ports. Development preview follows the same topology.
- Deferring the shared calendar was tested and reverted. First use increased from 119 to 384 ms
  on desktop and from 307 to 724 ms under constrained mobile. Moving that wait onto an interaction
  did not satisfy the requested experience. Its cold observations remain labeled as a rejected
  candidate rather than final-head evidence.
- The repository dependency gate required the newly eligible `@cloudflare/workers-types`
  5.20261022.1 in both existing development manifests.
- CI then reported nine advisories across Seroval, systeminformation and the Hono Node adapter.
  Eligible fixes are pinned at 1.6.11, 5.33.16 and 2.1.3 respectively, preserving the seven-day
  delay and existing vulnerability gates. Seroval is inherited through the browser router;
  systeminformation and the Node adapter are tooling dependencies. The Node adapter is a major
  update, so type, infrastructure and browser compatibility are part of validation. The final
  cold run is separate from the earlier UI-only measurements that used the original dependencies.

## Method and interpretation

All local comparisons use base revision `67335840a1`, Bun 1.4.1, Chrome 156.0.8078.73, the existing
heavy synthetic fixture, the same loopback topology and uncompressed preview, and one serial browser
worker. The final software revision is `2e5e81fa63`; subsequent report edits do not change that code.
Each cold document stops the previous page, waits twelve seconds outside measurement to
refill the unchanged allowance, and clears the browser cache. Mobile uses 390×844, 4× CPU slowdown,
150 ms latency, 200,000 bytes/s download, and 93,750 bytes/s upload.

There is one observation per route/profile/stage. They are descriptive samples on a shared Mac,
not confidence intervals, production percentiles, or proof of consistent speedup. Readiness includes
driver overhead and two animation frames. Resource capture may follow readiness by up to 500 ms;
incomplete resources can have zero recorded bytes, and cross-origin timing restrictions obscure some
API byte counts. Summed encoded body sizes are not complete wire bytes or a causal decomposition.
Unknown request sizes/durations remain `-1`, rather than being counted as zero.

The accompanying [measurement file](app-performance-cold-start-2026-10-28.json) retains every route's
readiness outcome, loading observations, API metadata, and long tasks. Full Transactions and Dashboard
resource waterfalls are included for each stage. Raw Playwright reports for all routes remain under
the ignored `reports/performance/cold-start/` directory. Rejected-candidate and artwork-only runs
remain separate from the final implementation.

## Final local cold observations

All 18 attempted documents reached readiness before and after; these are single observations.

| Workspace    | Desktop before → final (ms) | Constrained mobile before → final (ms) |
| ------------ | --------------------------: | -------------------------------------: |
| transactions |                   781 → 393 |                        10,797 → 10,491 |
| budgets      |                   751 → 400 |                         10,406 → 9,075 |
| recurring    |               1,378 → 1,022 |                        12,779 → 10,918 |
| dashboard    |                   658 → 439 |                        11,451 → 10,692 |
| review       |                   330 → 327 |                        12,424 → 11,826 |
| account      |                   620 → 196 |                          8,315 → 7,163 |
| access       |                   719 → 601 |                          9,179 → 8,573 |
| upgrade      |                   315 → 654 |                          9,044 → 8,706 |
| privacy      |                   371 → 249 |                          8,865 → 7,630 |

Cold mobile Transactions remained above ten seconds. These single observations do not support a
consistent 2× claim or isolate causality from variation between runs. The deterministic improvement
is eliminating hidden artwork requests, not a guaranteed page-latency multiplier.

## Reproduction

From `apps/web` on this Mac:

```sh
CLI_ACCEPTANCE_MODE=oauth FIDY_ASSESSMENT=heavy \
  ASSESSMENT_CHROMIUM='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  bun --bun playwright test --config playwright.assessment.config.ts --grep 'isolated cold'
```

Use `--grep 'first date picker'` for the first-use probe, `--grep 'assesses all'` for rapid navigation,
or `FIDY_ASSESSMENT=breaking` for the million-Transaction fixture. Run browser invocations serially.
The ordinary acceptance configuration and performance thresholds are unchanged.

## Remaining work

[#1593](https://github.com/B4rz99/fidy-ai/issues/1593) remains open. Cold transfer/execution and
sequential session/Consent/profile/data acquisition still need substantial improvement. Production
request-pressure and Recurring suggestion failures need correlation with server-side evidence.
No Production before/after ratio is claimed from these pre-deployment observations. Provider protocol
proofs and per-call provider latency are distinct; neither browser fixtures nor complete test-suite
durations establish live provider latency.

## Million-Transaction tier and validation

The breaking-tier attempt used the UI-only code before the SCA dependency refresh and exhausted
the unchanged 600,000 ms web-server preparation budget:
`Timed out waiting 600000ms from config.webServer`. Before cancellation, a read-only inspection
of the isolated native D1 fixture observed 655,000 Transactions for the assessment User at about
9 minutes 46 seconds of fixture-process lifetime. Production projection triggers remained active.
The API health listener had not started, and no browser-readiness samples ran. This is a fixture
preparation failure, not a million-Transaction page-latency result or a Production failure. The
million-Transaction readiness tier remains unmeasured; its preparation cost needs its own diagnosis.

Local validation passed 314 web unit tests, 310 Cloudflare infrastructure tests, repository static
verification, and seven focused browser cases covering hidden artwork plus Google/Microsoft signup,
recovery disclosure, persisted
session, denial and cancellation. The original hidden-artwork test failed before the fix and passed
afterward. Ordinary acceptance/performance deadlines and the assessment's setup deadline were not
relaxed. The rejected calendar candidate separately passed date-selection and failed-chunk recovery
checks before being reverted for its measured first-use regression.

## Live sandbox protocol evidence

The existing protected workflows had configured provider credentials, so both were run against
base revision `67335840a1`. [Nequi](https://github.com/B4rz99/fidy-ai/actions/runs/40807113674) and
[DaviPlata](https://github.com/B4rz99/fidy-ai/actions/runs/40807116602) each passed four real Wompi
Sandbox protocol cases. The tests reject non-sandbox configuration and use isolated local D1 plus
synthetic provider identities. This is separate from browser presentation mocks and Production
application measurements.

| Protocol case                   | Nequi duration (ms) | DaviPlata duration (ms) |
| ------------------------------- | ------------------: | ----------------------: |
| Weekly first payment, approved  |               5,868 |                   5,956 |
| Monthly first payment, approved |               3,381 |                   2,087 |
| Yearly first payment, approved  |               3,554 |                  63,193 |
| Weekly first payment, declined  |             186,485 |                 247,121 |

These are complete protocol-case durations, including fixture work, multiple provider calls,
polling and bounded settlement decisions. They are **not individual provider HTTP latencies** and
are not comparable with UI-readiness samples. The full test invocations took 201.94 and 321.27 seconds.
Individual-call latency, other providers, browser-mediated sandbox authorization and Production
payment performance remain unmeasured. No credentials, provider identities or response bodies were
copied into this report.

References: [native lazy-loading behavior](https://web.dev/articles/browser-level-image-lazy-loading),
[React lazy loading](https://react.dev/reference/react/lazy),
[successful serving release](https://github.com/B4rz99/fidy-ai/actions/runs/40789032350),
[Seroval advisory](https://github.com/advisories/GHSA-f86p-h4j2-7qgj),
[Hono Node adapter fix](https://github.com/honojs/node-server/releases/tag/v2.1.3),
[systeminformation fix](https://github.com/sebhildebrandt/systeminformation/releases/tag/v5.33.16).
