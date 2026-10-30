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
can include preflight representations; they must not all be counted as business requests.

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
