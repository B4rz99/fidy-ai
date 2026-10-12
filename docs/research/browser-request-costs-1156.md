# Browser request and local D1 budget (#1156)

## Decision

Keep the current payment and ordinary Browser Login pacing. Their observations are bounded,
sequential, and necessary for authoritative completion. Query reloads after route teardown preserve
freshness; HTTP `no-store` must remain. There is no evidence here for a shared, persistent, or
cross-authentication query cache.

Provider status continues while the parent page is hidden. This is reproducible avoidable work,
but each pending observation costs only two local D1 reads and no writes. A possible follow-up is
visibility suspension **only for pending observations**, with an immediate observation on resume
and the original absolute deadline. Preserve popup-closure verification and association confirmation;
never automatically replay `start`, `complete`, payment submission, or confirmation. Its regression
should hide a pending attempt for 60 seconds (zero status requests), resume (one immediate request),
then verify terminal/cancel/unmount stop it, including popup completion while hidden. This report
proposes that bounded change; it does not change product polling or reopen #517 / PR #542.

## Reproduction and limits

Measured against baseline `6ecbe8efbd33f0fc462f629823bddc641bad2e74`, on macOS arm64,
Bun `1.4.3-canary.1+13a98b0db`, Playwright 1.63.0 Chromium, built production-mode static shell,
local Miniflare/workerd D1 with current migrations. This is synthetic fixture evidence, **not
Production telemetry**. Dependencies were copied from an existing local installation after a stalled
install; Vite was 8.3.1 rather than the lockfile's 8.3.2. The current Alchemy patch was applied locally.
No dependency files changed. Reproduction should install the frozen lockfile first.

```sh
bun install --frozen-lockfile
cd apps/web
BROWSER_COST_MEASUREMENT=1 bun ../../node_modules/@playwright/test/cli.js test \
  --config playwright.config.ts browser-cost.spec.ts
```

Use the repository-pinned Bun executable. Stop other acceptance servers on ports 4173–4175 first.
Measurement mode starts a fresh topology, uses one worker, and must select only this file: the D1
counter is topology-wide. Each test uses a fresh browser context. The authenticated fixture is the
seeded User with no owned Transactions, the migrated Categories, one foreign User Transaction, and
a saved synthetic payment source. Provider
Google authorization is a held-open synthetic popup; no external provider traffic is measured.
Payment collection is triggered through the local operator with a synthetic provider response.

`BROWSER_COST` JSON reports initiated requests (`attempts`), completed responses by normalized
method/path/status (`requests`), and native D1 `meta.rows_read` / `meta.rows_written` deltas. It excludes
CORS OPTIONS, SQL, arguments, identifiers, response bodies and credentials. Only the Core browser
binding and UserTransactionCoordinator binding are observed. Seed/operator setup and background
Billing collection use the original binding. These are D1 rows, not query counts, CPU, Durable Object
storage, network latency or dollars. `all`, `first`, `run`, bound statements, batch and sessions are
counted; `raw`/`exec` are not used by these measured requests and are not counted. Native integration
coverage checks session/batch/direct results against the exact returned D1 metadata.

Visibility is simulated by overriding `document.visibilityState` and dispatching `visibilitychange`;
it exercises application behavior without claiming OS background throttling. Real timers measure
pending polling; Playwright's clock advances cancellation/hidden/terminal windows. A response can
precede rendering, so zero follow-up windows and native counters are checked separately. Routes use
network-idle boundaries before costs are sampled. Rapid repeat navigation intentionally encounters
server rate limits; 429 responses and retries are reported instead of silently discarded.

## Measured scenarios

| Scenario                                    | Initiated / completed | D1 reads | D1 writes |
| ------------------------------------------- | --------------------: | -------: | --------: |
| provider-start-and-four-status              |                 6 / 6 |       14 |         7 |
| provider-hidden-three-status                |                 3 / 3 |        6 |         0 |
| provider-cancelled-20s                      |                 0 / 0 |        0 |         0 |
| ordinary-start-and-two-pending-polls        |                 3 / 3 |        8 |         5 |
| ordinary-after-route-unmount                |                 0 / 0 |        0 |         0 |
| three-document-navigation-round-trips       |               19 / 19 |      484 |       267 |
| three-spa-navigation-round-trips            |               14 / 14 |      497 |       147 |
| payment-setup-and-first-poll                |                 9 / 9 |      134 |        86 |
| payment-two-pending-polls                   |                 2 / 2 |       14 |         0 |
| payment-hidden-60s                          |                 0 / 0 |        0 |         0 |
| payment-resumed-settlement-and-terminal-60s |                 1 / 1 |        8 |         0 |
| navigation-before-logout                    |                 3 / 3 |      189 |        44 |
| logout                                      |                 1 / 1 |        1 |         1 |
| authentication-replaced-60s                 |                 0 / 0 |        0 |         0 |

All three browser scenarios passed. The exact normalized route/status maps are in
[browser-request-costs-1156.json](browser-request-costs-1156.json). Provider and pending payment
per-observation costs were stable across local runs. Navigation totals varied with rate-limit
retries and fixture Audit/admission maintenance: the recorded document burst had one 429; the SPA
burst had five; the following payment setup had three. These totals include real request-side
admission/Audit writes, not just the final business SELECT. They are single-run deltas, not
statistical estimates. No initiated requests were left unmatched in the recorded windows.

The three document round trips made three successful requests each for offers, status, availability,
User, Categories and Transactions (18 successes + one retry). The three SPA returns made three
successful User/Categories/Transactions requests (nine successes + five retries). This reproduces
query removal/reload on view teardown, rather than a background periodic loop. Payment setup is
listed separately from its marginal two-poll window and operator collection is excluded.

## Owners, stopping and cache lifetime

| Owner                            | Request and pacing                                                                                           | Stop/retry/lifetime                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider controller              | `POST /web/providers/google/status`, immediate then one second after each reply                              | Ten-minute timeout; verified/rejected end observation; pending + closed popup cancels after a fresh observation. Status error refuses rather than endlessly retrying. Clear increments generation, interrupts active command and closes popup; view teardown clears it. Hidden state does not suspend. Association confirmation remains explicit.                                                                                               |
| Browser Login pairing controller | `POST /web/pairings/redeem`, advertised initial five seconds in this fixture                                 | Checks expiry before sleep and request. Pending/slowdown only lengthen server cadence; timed-out request doubles interval. Invalid/transport failures stop; authenticated result completes login. Atom registry/view teardown stops the loop and clears the private verifier.                                                                                                                                                                   |
| Subscription feature             | Billing-attempt GET for payment-pending; source-verifying uses its separate explicit enrollment continuation | At most 65 sequential refreshes: three at one second, six at five seconds, remaining 56 at ten seconds. Failed refresh consumes an attempt and can retry; hidden waits without spending attempts, resume observes immediately. Terminal refused/settled stops. Flow/enrollment identity gates publication; unmount/authentication revokes its lifetime and interrupts work. Explicit submission/confirmation is never replaced by a cached GET. |
| Transaction view                 | User, Categories, Transactions query atoms                                                                   | No periodic timer. AtomHttpApi query family shares semantic query inputs within the authentication registry while observed. These queries specify no keepAlive/timeToLive. Unobserved nodes are scheduled for removal; remount can fetch again. Mutations invalidate owned state.                                                                                                                                                               |
| Subscription route               | Offers/status/availability query atoms                                                                       | Same observer lifetime, no periodic query timer; payment refresh is a separate scoped owner. Full document navigation creates new query state.                                                                                                                                                                                                                                                                                                  |
| SessionRegistryProvider          | Authentication epoch keyed RegistryProvider                                                                  | Login/logout/expiry/pairing restart replace registry. RegistryProvider creates its own registry without defaultIdleTTL (the global context's 400ms default does not apply). Provider disposal has a 500ms scheduling delay; payment's separate revocable lifetime stops stale publication immediately. No persistent browser storage or cross-User sharing.                                                                                     |

Source anchors: [provider controller](../../apps/web/src/features/provider-authentication/controller.ts),
[pairing controller](../../apps/web/src/features/browser-login/pairing-controller.ts),
[subscription feature](../../apps/web/src/features/subscription/feature.tsx),
[payment cadence](../../apps/web/src/features/subscription/payment-status.ts),
[session registry](../../apps/web/src/session/session.tsx), and installed upstream
`@effect/atom-react/src/RegistryContext.ts`, `effect/src/reactivity/AtomRegistry.ts`,
`effect/src/reactivity/AtomHttpApi.ts` (query timeToLive selects idleTTL/keepAlive).

The focused existing subscription/session suites pass 43 tests, including failed-refresh retry,
replaced-flow stale reply rejection, hidden-view unmount, terminal submission, and authentication
registry isolation. The browser measurement checks cancellation, route teardown, settlement,
hidden/resume and logout. Terminal provider/ordinary pairing and slowdown/expiry logic are also
source-verified; this report does not claim a new live provider-terminal measurement.

## Freshness and marginal cost budget

Recommended investigation budget: visible provider completion within one polling interval plus
request latency (one second), ordinary pairing within the server-advertised interval (five seconds
initially), payment within one/five/ten seconds plus latency, and an immediate payment observation on
resume. Hidden payment must spend zero attempts; terminal/cancel/unmounted owners must initiate zero
stale requests. Maintain authentication-scoped memory and no-store on every observed API response,
including refusals. These are explicit proposed product budgets, not measured Production SLAs.

With negligible response time, provider's ten-minute cap allows about 600 observations, or about
1,200 reads and zero status writes at this fixture's two-read pending cost. Startup adds six reads
and seven writes. Ordinary pairing's five-second interval and ten-minute expiry allow at most 119
pending observations before expiry (transport/slowdown reduce frequency). Payment delays total 593
seconds for 65 visible refreshes; at seven reads per pending attempt the marginal bound is 455 reads
and zero observation writes. Hidden time can extend wall time but not the attempt budget. Settlement
cost and source-verifying work differ; don't generalize the pending cost to those states.

Frontend frequency multiplies **per-request backend work**. #1137 measured a 101-row effective-history
page at roughly 4,035,000 reads before ANALYZE / 43,000 after, with 2,000 Transactions and 1,000 linked
pairs; projection correction work was roughly 75,870 reads. Draft PR #1152 measures Dashboard search
at 60,000–100,000 reads for common global matches versus a proposed 50-read User-local path, while
rare/absent User-local search can cost 20,000 reads. Those different datasets/query shapes cannot be
summed with this small fixture or described as browser cache defects. One expensive history request
can exceed an entire pending provider/payment observation window by orders of magnitude. This work
measures the frontend multiplier and leaves the stopped Dashboard/backend investigations untouched.

For normal navigation, budget one successful query per required semantic input per mounted owner;
full reload or disposed observer is allowed to revalidate. Do not impose a global TTL merely to hide
backend amplification. The burst scenario's 429s show why future frequency work must preserve
Retry-After/server pacing. Establish Production route frequency and account/history distribution
before prioritizing a cache change or translating local rows into service cost.
