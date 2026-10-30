# Production desktop startup: October 29, 2026

The matched production comparison does **not** establish the app-wide 2x target. All 54
observations reached usable controls, but none of the nine page medians improved by 2x.
Most pages transferred 71–75% fewer completed encoded resource bytes. API waits still
dominate the slower pages, and several observed startup medians increased.

## Releases and method

The baseline served revision `90bdfb2aae31a4ca952ca021103a8fbfbb8fb6fc`, contract digest
`935282207549fbc70a15632d74d3b9a4ee2c04a37380ac82ab67a9da68428b38`.
The candidate served merged revision `952157f1b040552744e4b356b0f91c4c3a46d946`, digest
`601bd69a4a42aeb9d4317f7aef8bf71092da08ad2e78c277c8565b4d85c11b8f`.
Both app deployment metadata and API health matched before and after the candidate batch.

[PR #1618](https://github.com/B4rz99/fidy-ai/pull/1618) merged after
[all required CI passed](https://github.com/B4rz99/fidy-ai/actions/runs/40976344976).
The [production release workflow passed](https://github.com/B4rz99/fidy-ai/actions/runs/40978881881)
before candidate measurement began. These gates establish functional and release validation;
they do not establish the performance target.

Measurements used the existing signed-in production browser session, a 1280×720 desktop
viewport, CPU rate 1, disabled browser cache and three fresh-document reloads per page.
The same route-specific readiness conditions were used on both releases. Readiness was
observed with 25 ms polling after the browser's new-document state check, with the original
20-second limit. A 12-second admission refill gap preceded each reload and was excluded
from its measured time. No artificial network throttling was applied. Cache and viewport
overrides were restored afterward.

The conditions were Transactions' Registrar button, Budgets' previous-month button,
Recurring's new-plan button, Dashboard's customize button, Review's amount control or
validated empty state, Account's new-email input, Access's empty-token state, Upgrade's
monthly-offer button and Privacy's current-authorization marker. These are observations
of usable controls, not submission, payment or provider timings. No financial, account,
subscription or provider changes were made.

## Results

Times are descriptive medians in milliseconds. Positive latency change means slower.
The complete numeric observations and API resource spans are in the
[measurement artifact](app-performance-production-desktop-2026-10-29.json).

| Page         | Before ms | After ms | Speedup | Latency change | Resource byte reduction |
| ------------ | --------: | -------: | ------: | -------------: | ----------------------: |
| Transactions |    2747.4 |   3238.7 |  0.848x |         +17.9% |                   71.7% |
| Budgets      |    3495.4 |   3435.3 |  1.017x |          -1.7% |                   73.5% |
| Recurring    |    3039.7 |   3339.9 |  0.910x |          +9.9% |                   72.1% |
| Dashboard    |    3820.3 |   3685.1 |  1.037x |          -3.5% |                   70.7% |
| Review       |    1563.7 |   1551.9 |  1.008x |          -0.8% |                   71.7% |
| Account      |     666.0 |    751.5 |  0.886x |         +12.8% |                    8.4% |
| Access       |    1121.7 |   1433.1 |  0.783x |         +27.8% |                   74.0% |
| Upgrade      |    2040.6 |   2258.1 |  0.904x |         +10.7% |                   73.8% |
| Privacy      |    1191.8 |   1837.5 |  0.649x |         +54.2% |                   74.5% |

Three observations provide no confidence interval or broad consistency claim. The batches
ran sequentially, roughly half an hour apart; network and service conditions may vary.
Completed encoded resource bytes include noncritical assets and omit unfinished transfers.
Their reduction is not a causal estimate of startup improvement. API resource timing entries
include opaque cross-origin fetch observations, including short attempts whose outcomes were
not established; they must not all be counted as completed business requests.

## Remaining investigation

Transactions still has a sequential binding → Consent → User → financial-data path.
Recurring's request takes about two seconds and Dashboard's main request about three
seconds. Those durations identify useful boundaries to investigate; they do not separate
database execution, transport and other server work.

The Recurring date-conversion optimization reduced repeated conversions in its native
cost test, but the production page regression remains unresolved in this comparison.
Follow-up work must reduce unnecessary database work and round trips, preserve fresh
authority and projection completeness, and then repeat the deployed measurements.
[Issue #1593](https://github.com/B4rz99/fidy-ai/issues/1593) remains open. The million-row
preparation failure and unmeasured live-provider work remain documented in the
[earlier assessment](app-performance-startup-2026-10-29.md).

## Follow-up native query work

Two native regressions identify removable work after this production checkpoint:

- An empty Recurring workspace performed two Transaction range reads despite having no
  plans to match. The new cost assertion failed with two reads, then passed with zero
  after an empty-plan fast path. Document, preference, authority and Audit reads remain.
- A Dashboard document request read the same established document twice. The new native
  assertion failed with two reads, then passed with one after the projection reused the
  document read in that request. Post-mutation reads still load the committed document.

The combined Dashboard and Recurring suites passed 93 tests with one existing skip.
These are query-work reductions, not deployed latency measurements. They are not included
in revision `952157f1` or the before/after table above. A separate default-Dashboard
probe already passed with one aggregate batch, so batching its ranges was not adopted
as an explanation or fix for that observed page delay.

## Deployed follow-up: revision 11fa1c22

[PR #1619](https://github.com/B4rz99/fidy-ai/pull/1619) merged as
`11fa1c2271a9c00b8dcc7ddb6cb28a9c133f83c8` after
[all CI passed](https://github.com/B4rz99/fidy-ai/actions/runs/40982725160).
Its [production deployment passed](https://github.com/B4rz99/fidy-ai/actions/runs/40983518647).
App and API metadata matched that revision before and after six further desktop cold loads,
using the same viewport, cache, CPU, admission gap and readiness conditions. All six were ready.

| Page      | Three observations ms  | Median ms | Speedup versus original 90bdfb2 |
| --------- | ---------------------- | --------: | ------------------------------: |
| Recurring | 4156.2, 3915.1, 4359.0 |    4156.2 |                          0.731x |
| Dashboard | 5373.3, 2958.1, 2943.6 |    2958.1 |                          1.291x |

The Dashboard outlier remains in the artifact. The new median does not establish 2x,
and the Recurring page regression remains unresolved. Resource spans show substantial
variation in API waits; these sequential batches do not isolate the code change from
service conditions. An additional read of the existing Recurring response, retaining
only counts, found one retained plan and no fulfillments. The empty-plan fast path does
not apply to that workload. The JSON artifact's `planningFollowUp` contains all six samples.

A supplementary Account probe lost its debugger tab binding and produced no valid
readiness observation. It is excluded from latency comparisons. Its available resource
waterfall showed binding discovery starting after the main JavaScript startup; that is
an investigation lead, not an improvement measurement. The matched follow-up harness
passes the recovered tab and debugger handles explicitly and retains the 20-second limit.

## Native User startup change

The bound browser User request performed four native statements: ingress binding discovery,
idle renewal, canonical User projection and the final live-credential Audit. A regression
assertion failed at four statements and passed at three after the expected binding was
checked in the existing renewal statement. The final projection and late authority check
remain separate. All 44 focused tests passed, including wrong/missing/malformed binding,
duplicate cookies, expiry and revocation during projection. This is not a deployed latency
measurement of that change.

## Deployed follow-up: revision b2a2234d

[PR #1620](https://github.com/B4rz99/fidy-ai/pull/1620) merged as
`b2a2234de15e9a979994ea1e0c2b3ef0cf333089` after
[all required checks passed](https://github.com/B4rz99/fidy-ai/actions/runs/40989664299).
The [production workflow passed](https://github.com/B4rz99/fidy-ai/actions/runs/40990417504).
App and API revision and contract digest matched before and after 27 further desktop
observations. Every observation was ready; no page median reached 2x. The browser cache,
CPU and viewport overrides were restored after measurement. All numeric observations,
including slow samples, are retained in the JSON artifact's `boundUserFollowUp`.

| Page         | Median ms | Speedup versus original 90bdfb2 |
| ------------ | --------: | ------------------------------: |
| Transactions |    4387.4 |                          0.626x |
| Budgets      |    4057.1 |                          0.862x |
| Recurring    |    3922.3 |                          0.775x |
| Dashboard    |    3998.8 |                          0.955x |
| Review       |    2283.4 |                          0.685x |
| Account      |    1135.2 |                          0.587x |
| Access       |    1817.0 |                          0.617x |
| Upgrade      |    3792.0 |                          0.538x |
| Privacy      |    2048.4 |                          0.582x |

These sequential observations do not isolate the User change from service, network or
browser-observation conditions. Account called only session binding, and Review did not
call the changed User endpoint; both also became slower. The native statement reduction
therefore establishes less work, without establishing a deployed startup improvement.
Recurring's main API spans were approximately 2.24–2.42 seconds. Its two separately bounded
matching ranges and preference read are the next round-trip investigation. The original
readiness criteria and 20-second limit were retained. The related performance chat paused
heavy local checks during the main measurement window, including its final extension;
the first Transactions samples preceded that acknowledgement.

## Next native Recurring snapshot change

A nonempty workspace's preferences and two matching ranges performed three native round
trips. A regression test failed with three and passed with one batch after those reads
were composed through the existing Identity context projection and Transaction owner.
The two range statements retain independent 128-fact limits and completeness results;
they are not replaced by a combined range. Empty workspaces still read no matching ranges.
The broader native suite passed 290 tests with 11 existing skips, including 200 own-User
facts across two complete ranges, 129 excluded foreign-User facts, and an incomplete earlier
month. Authority, credential renewal and the final live-credential Audit remain outside
this refactor.

## Deployed follow-up: revision 228da62e

[PR #1621](https://github.com/B4rz99/fidy-ai/pull/1621) merged as
`228da62e81a7031d5c0c1f4f6dcae9f869538698` after
[all CI passed](https://github.com/B4rz99/fidy-ai/actions/runs/40994332382).
Its [production workflow passed](https://github.com/B4rz99/fidy-ai/actions/runs/40995013179).
Both app/API metadata checks matched before and after six further desktop observations.
All six reached usable controls, and all browser overrides were restored afterward.

| Page      | Three observations ms  | Median ms | Speedup versus original 90bdfb2 |
| --------- | ---------------------- | --------: | ------------------------------: |
| Recurring | 3555.4, 3028.9, 3294.8 |    3294.8 |                          0.923x |
| Dashboard | 3577.1, 3683.8, 3573.5 |    3577.1 |                          1.068x |

Recurring's median was about 16% below the preceding b2a2234d batch, and its two completed
main API spans were approximately 1.73–1.78 seconds. Dashboard, whose implementation was
unchanged in this release, also fell about 11%. The samples therefore do not isolate a causal
16% improvement from the native batching change. Neither page meets the original 2x target.
The JSON artifact's `recurringSnapshotFollowUp` retains every observation. A fresh tab in the
same authenticated browser recovered unavailable browser controls; the related performance
chat again paused heavy local checks for this measurement window.

The canonical browser dispatch trace already avoids a separate ingress binding lookup and
combines binding validation with admission; expanding the binding exception was ruled out.
Cross-origin resource status fields were opaque, and the optional debugger-event trace was
unavailable, so short fetch entries have no established response status or failure reason.

## Startup code-loading candidate

The production Vite manifest's static JavaScript closure initially contained 26 files,
723,448 raw bytes and 238,033 independently gzip-compressed bytes. Splitting the router and
bound clients into a module loaded alongside session discovery reduces the initial static
dependency graph. Clients still mount only inside the verified binding boundary, and a failed
code preload is retained as a failure for React's loader rather than an unhandled rejection.
This changes code loading, not binding, request admission or authentication lifetimes.
The JSON artifact records the before/candidate file inventories and sizes. Those dependency
counts alone do not establish faster startup; matched desktop measurements remain required.

## Sign-in recovery and the quota hypothesis

Before the daily reset, the sign-in attempt failed at `POST /web/pairings` with HTTP 503,
before Google authentication. Around `2026-10-30 00:00:14 UTC` (7 p.m. October 29 in
Bogotá), the existing session again loaded authenticated Transactions controls and its
required API reads returned 200, without another Google sign-in.

Cloudflare documents that D1 Free daily read/write limit errors clear at
[midnight UTC](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).
The observed recovery strongly supports the user's quota hypothesis. Account-level usage
and a quota-specific database error were not obtained, so exhaustion is not confirmed.
The API health response alone is not a database-availability proof.
