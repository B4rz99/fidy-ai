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

Build the historical baseline from `0db958ab57b3e47991df8e25feda52db798de4c6`, before the HTML
implementation and already on Effect 4.0.7. Apply the candidate's final workspace package pins,
lockfile, AWS record compatibility patch and build configuration. Copy the common observational
harness and logical fixture builders byte for byte. Adapt only the private fixture host to seed
those facts and return their preparation fingerprint. Keep the historical Core, browser source,
renderer, static preview and cross-origin production launcher unchanged. A classifier entry for an
absent candidate bootstrap module in the shared Vite configuration remains unreachable.

Set `FIDY_ASSESSMENT_SURFACE=legacy-cross-origin` on this baseline and `same-origin` on the HTML
candidate. This selects only the observer's public API address; it does not change application
routing. The assessment config verifies that the pinned production launcher actually uses the
selected surface. Record both full resulting commit hashes and audit the baseline patch against
the historical revision before collecting. The older 08d graph with Effect 4.0.6 is not matched.

`harnessDigest`, `fixtureDigest` and `dependenciesDigest` must match across the pair. The fixture
fingerprint includes the exact common builders, selected logical history and prepared document.
`adapterDigest` separately pins the preview, seed adapter, static/native host and base launcher;
these intentionally differ because the implementations differ. They are also covered by each
clean source revision. A different adapter never permits different workload or financial facts.
Use `FIDY_DASHBOARD_SAMPLES=1` for functional setup controls only; such artifacts cannot qualify
latency targets. Coordinate a quiet host window before collecting any distributions.

Compare sidecars from clean, fully sampled checkouts:

```sh
bun apps/web/scripts/dashboard-qualification.ts /absolute/baseline.json /absolute/candidate.json
```

`FIDY_DASHBOARD_BACKEND=legacy-d1` selects the legacy D1 fixture. `audited-native-guarded` selects
one actual native Store namespace for fixture seeding, Core, coordinators and the named document
entry. Its closed bootstrap and logical clock are test-only. `audited-native-qualified` continues
to refuse preparation until provider qualification is complete. A D1-shaped facade cannot qualify
native routing. Invocation-local `nativeCalls` record actual Store Dashboard RPCs, generic Store
RPCs, named document entry RPCs and R2 operations separately. Missing observations remain -1. Full
browser elapsed includes the private fixture HTTP document bridge; do not subtract it. Clock
headers retain the observed logical clock in each realm. The comparator reports complete local,
remote application-added and complete remote request measurements as `not-measured`; these require
separate end-to-end public-request observations and measured native RPC/R2/control-plane counters.
No browser fixture or loopback paint result establishes these targets.

Browser samples retain API request counts, response bytes and phase timings where available.
`reportedRecoveryBatches` retains the request-local `fidy-recovery-batches` header as a guarded-batch
subtotal when exposed; -1 means absent. It is not a total across Worker/coordinator boundaries or
an R2 generation-read count.
A byte/duration sentinel of -1 means the browser transport could not obtain that observation.
Legacy browser transport cannot observe database round trips or R2 generation checks. The native
guarded fixture exposes actual private binding and R2 operation counts through test-only response
headers; these are independent observations, rather than inferred phase durations. Measure the
complete native public request seam separately for its latency target. Do not infer them
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

## Diagnose a long-seed native transport failure

The synthetic engine probe can retain an initial failed read and continue separate diagnostic
requests for COUNT, streaming plain/effective cursors, Money decoding and complete folding. These
requests keep scalar counts and bounded results; they never materialize a million-row array. The
original failed read still fails the test. Run outside qualification collection:

```sh
DASHBOARD_ENGINE_STRESS=true DASHBOARD_ENGINE_DIAGNOSTIC=true \
  bun run --cwd apps/server test:cloudflare -- cloudflare/dashboard/sqlite-engine-proof.test.ts \
  -t 'keeps cursor working groups bounded'
```

`DASHBOARD_ENGINE_DIAGNOSTIC_SMALL=true` selects a 500-row functional control.
`DASHBOARD_ENGINE_FRESH_AFTER_SEED=true` sends `Connection: close` on the synthetic seed request
and writes a separate `dashboard-engine-fresh-connection.json`, preserving the original stress
artifact. Compare the first read and every subsequent diagnostic outcome before assigning a cause.
These fixture HTTP requests are not production native RPCs and do not authorize automatic replay of
production financial work. Generated artifacts remain under ignored `apps/server/test-results`.
