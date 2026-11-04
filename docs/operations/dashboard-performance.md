# Fresh Dashboard measurements

Run the production browser artifact against the disposable native Core fixture. Authentication,
explicit fixture preparation, initial Dashboard creation and the initial admission refill precede
sampling. Each pair contains a cache-cleared direct document entry, followed by an in-app visit to
Transactions and return to Dashboard. Returning does not replace the document or authentication
registry. Neither journey can qualify from retained display alone.

The probe timestamps navigation in the browser. A completed fresh view resource or a private initial HTML document with matching successful
financial status, committed ready state and an enabled Dashboard action are required. Returns additionally
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

| Axis           | Pinned values                                                    |
| -------------- | ---------------------------------------------------------------- |
| Transactions   | small: 500; heavy: 10,000; extreme: 100,000; breaking: 1,000,000 |
| Desktop        | 1280 × 720; CPU rate 1                                           |
| Mobile         | 390 × 844; CPU rate 4                                            |
| Normal network | loopback, no network emulation                                   |
| Poor network   | 400 ms latency; download 51,200 bytes/s; upload 25,600 bytes/s   |
| Traffic        | 1/8/32 distinct Users; 1/2 tabs; fixed 12 s offers per actor     |
| Samples        | 30 or more per User/tab/journey for qualification; no retries    |

The fixture seeds every selected User independently and pins the logical calendar with
`FIDY_ASSESSMENT_EPOCH` (the same ISO instant on both revisions). Set
`FIDY_DASHBOARD_USERS=1|8|32`, `FIDY_DASHBOARD_HISTORY=routine|dense|wide|reconciled|recurring`,
and `FIDY_DASHBOARD_LAYOUT=default|maximum`. Maximum layouts contain 24 Widgets spanning all
four Widget kinds. Dense histories use distinct Money amounts in the current period; wide histories
retain exact large decimal amounts; Reconciliation histories link pairs without deleting retained
Transactions. The default layout also has deterministic Widget identities.

`FIDY_DASHBOARD_ACTIVITY=ingestion-two-tabs` opens two tabs per User and offers concurrent manual
Transaction captures through the canonical public operation. Capture failures and timeouts remain
in the artifact. This exercises concurrent writes, but does not qualify statement parsing or provider
ingestion. Quiet cohorts use one tab. Fixed synthetic identities and separate browser contexts prove
the selected Users; authentication and fixture setup finish before offers begin. A missed offering
interval disqualifies the cohort instead of silently reducing offered load.

Use a stratified matched matrix, recording every omitted cohort explicitly:

| Dataset  | Users | History    | Layout  | Activity           | Profiles/networks           |
| -------- | ----- | ---------- | ------- | ------------------ | --------------------------- |
| small    | 1     | routine    | default | quiet              | desktop/normal, mobile/poor |
| heavy    | 8     | dense      | maximum | quiet              | desktop/normal, mobile/poor |
| heavy    | 32    | wide       | maximum | quiet              | desktop/normal, mobile/poor |
| heavy    | 1     | reconciled | maximum | ingestion-two-tabs | desktop/normal, mobile/poor |
| extreme  | 8     | recurring  | maximum | quiet              | desktop/normal, mobile/poor |
| breaking | 1     | wide       | maximum | ingestion-two-tabs | desktop/normal, mobile/poor |

Run each row on baseline and candidate with at least 30 offers per User/tab/journey. Keep failures,
timeouts and absent fresh reads beside successful statistics. Thirty successful fresh paints are
required for every actor and journey before comparison can meet its target. Thirty observations
cannot establish a precise tail distribution; p99 is near the observed maximum.

The sidecar `apps/web/reports/performance/dashboard-cohort-<backend>-<dataset>-<profile>-<network>-<users>users-<history>-<layout>-<activity>.json`
pins actual Git HEAD and clean source status, the Chromium executable hash, Bun version, lockfile
and build configuration, fixture source and layout, probe source, compression, epoch and workload.
Set `ASSESSMENT_CHROMIUM` to the same pinned executable for both revisions. An optional
`FIDY_ASSESSMENT_REVISION` must equal actual HEAD. Qualification rejects dirty source, unmatched
fingerprints, incomplete setup, missing activity, missed pacing and duplicate actor attempts.

The proposed HTML baseline is `0db958ab5` with the same final maintenance package pins and AWS
record patch as the candidate, plus identical observational harness and fixtures. Preserve the old
product behavior: copying the candidate bootstrap or renderer into the baseline invalidates the
comparison. Pin full resulting commit hashes and review the baseline patch before collecting.
The older 08d graph with Effect 4.0.6 is not a matched baseline.

Compare sidecars from clean, fully sampled checkouts:

```sh
bun apps/web/scripts/dashboard-qualification.ts /absolute/baseline.json /absolute/candidate.json
```

`FIDY_DASHBOARD_BACKEND=legacy-d1` selects the current fixture. The two audited native backend
labels deliberately refuse preparation until the fixture invokes the real authoritative native
Actor path. A legacy facade cannot qualify native routing. The comparator reports complete local,
remote application-added and complete remote request measurements as `not-measured`; these require
separate end-to-end public-request observations and measured native RPC/R2/control-plane counters.
No browser fixture or loopback paint result establishes these targets.

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

The HTML candidate uses the same probe clock and two-frame confirmation. Its direct document
qualifies only while the initial private transfer declares a successful financial read and the
navigation itself is successful. `fidy-dashboard-status` carries that financial status for the
request log; an HTTP 200 asset shell cannot conceal a refused financial read. Returns still require
a fresh successful fragment and a pending-to-ready commit. Direct documents include all assets in
the measured navigation; document and fragment durations therefore describe different journeys.

Chromium may expose `PerformanceResourceTiming.responseStatus` as zero for a successful proxied
fragment. Zero is unavailable status metadata. Fragment qualification therefore combines a completed
fresh resource, the current visit's pending-to-ready typed-client commit and the independently
recorded public HTTP 200 response. Refused reads never enter successful statistics. The direct
probe additionally verifies the navigation response status before accepting its initial marker.
