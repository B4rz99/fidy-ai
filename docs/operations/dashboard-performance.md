# Fresh Dashboard measurements

Run the production browser artifact against the disposable native Core fixture. Authentication,
explicit fixture preparation, initial Dashboard creation and the initial admission refill precede
sampling. Each pair contains a cache-cleared direct document entry, followed by an in-app visit to
Transactions and return to Dashboard. Returning does not replace the document or authentication
registry. Neither journey can qualify from retained display alone.

The probe timestamps navigation in the browser. A completed fresh view resource, successful HTTP
status, committed ready state and an enabled Dashboard action are required. Returns additionally
require a pending-to-ready transition after that navigation started. The first eligible animation
frame supplies elapsed time; the following frame confirms readiness and records its extra elapsed
time separately. This is a browser paint-opportunity measurement, not compositor presentation timing.

The artifact records observed positive clock ticks (zero means none observed), average clock-read
cost, measured observer callback work per navigation and frame-confirmation overhead. These account
for explicit probe work; browser scheduling and observer delivery can still affect results. Never
subtract the probe work to manufacture a faster duration. Preserve original attempts and report
that limitation when interpreting sub-frame targets.

## Reproduce a cohort

Check ownership of ports 4183–4185 and the pinned Chromium installation as described in
[the testing pattern](../../.patterns/testing.md#browser-acceptance). The assessment config never
reuses another process's servers. From the repository root:

```sh
bun install --frozen-lockfile
cd apps/web
CLI_ACCEPTANCE_MODE=cli FIDY_ASSESSMENT=small FIDY_DASHBOARD_SAMPLES=30 \
  FIDY_ASSESSMENT_REVISION="$(git rev-parse HEAD)" \
  bun --bun playwright test --config playwright.assessment.config.ts \
  --grep 'fresh Dashboard.*desktop'
```

Repeat with `FIDY_ASSESSMENT=heavy`. Set `FIDY_ASSESSMENT_NETWORK=poor` for the pinned poor-network
profile. Select `mobile` in the grep to measure the mobile profile; omitting that suffix runs both.
The same commands and revisions must identify baseline and candidate artifacts. The JSON reporter
writes `reports/performance/assessment-<dataset>.json`, including the `dashboard-baseline`
attachment. Copy each ignored artifact before reusing the dataset name with a different profile.
Do not commit generated results; attach dated findings and evidence to the issue or PR.

| Axis           | Pinned values                                                                 |
| -------------- | ----------------------------------------------------------------------------- |
| Transactions   | small: 500; heavy: 10,000; extreme: 100,000; breaking: 1,000,000              |
| Desktop        | 1280 × 720; CPU rate 1                                                        |
| Mobile         | 390 × 844; CPU rate 4                                                         |
| Normal network | loopback, no network emulation                                                |
| Poor network   | 400 ms latency; download 51,200 bytes/s; upload 25,600 bytes/s                |
| Traffic        | one User; one tab; at least 12 s between attempts, excluding attempt duration |
| Samples        | default 20 per journey; use 30 or more for baseline collection; no retries    |

The existing native fixture owns amounts, date distribution, Category distribution, Budget caps,
RecurringPlan history and default Dashboard layout. The report pins its transaction count and source
revision. These are the routine baseline shapes; they do not claim dense wide-Money,
Reconciliation-heavy or maximum-layout qualification. The native fixture retains real admission
and recovery fencing. Refusals, timeouts and absent fresh reads stay in the artifact and its cohort
summary. Successful paints alone enter p95, p99 and maximum; report offered and successful counts
beside those statistics. Thirty observations cannot establish a precise tail distribution; p99 is
near the observed maximum, not proof of a reliable production tail.

Browser samples retain API request counts, response bytes and phase timings where available.
`reportedRecoveryBatches` retains the request-local `fidy-recovery-batches` header as a guarded-batch
subtotal when exposed; -1 means absent. It is not a total across Worker/coordinator boundaries or
an R2 generation-read count.
A byte/duration sentinel of -1 means the browser transport could not obtain that observation.
Database round trips and R2 generation-check counts are explicitly unavailable from browser
transport: measure those separately at the native Dashboard public request seam. Do not infer them
from phase duration or reuse earlier counts for a different revision.

The complete 1/8/32-User, two-tab ingestion, remote-provider, wide-Money, maximum-layout and paired
backend/renderer qualification belongs to issue #1852. Loopback browser elapsed time does not prove
the 0.1 ms full-local-request or 6 ms remote application-added targets, or a 10× improvement.
