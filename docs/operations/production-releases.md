# Production releases

GitHub Actions coordinates every Production release through
[`.github/workflows/production.yml`](../../.github/workflows/production.yml). Do not deploy from a
provider repository integration or from a workstation.

Before enabling real onboarding, complete the [Production launch proof](production-launch.md).
An ordinary passing release is not launch approval; that checklist records live evidence, synthetic
cleanup, and the explicit operator decision without relaxing applied-migration guards.

## Authority and provider setup

`infra/cloudflare/alchemy.run.ts` is the sole Production topology authority. It declares the static
application, apex redirect, public ingress Worker, private Core Worker, service binding, and release
metadata bindings as one Alchemy stack. Remote stages other than `production` are rejected before
resource creation. Pull requests validate builds without deploying preview sites. The legacy
`fidy-web-preview` Worker and its public aliases were created outside Alchemy; removing the preview
workflow does not delete those existing Cloudflare resources. An account operator must retire that
Worker separately after confirming Production `fidy-web` remains untouched.

Create the GitHub `production` environment and configure:

| Kind     | Name                    | Purpose                                                                             |
| -------- | ----------------------- | ----------------------------------------------------------------------------------- |
| Secret   | `CLOUDFLARE_API_TOKEN`  | Alchemy-managed Workers, D1, DNS, and edge security changes                         |
| Secret   | `SMOKE_PROOF`           | Independent 32-byte random hex credential for the reserved release probe            |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account owning the Fidy resources                                        |
| Variable | `OPERATOR_ALERT_EMAIL`  | Validated sole-operator destination for Production health and release-failure email |

Scope the token to that account and the `fidyapp.com` zone, with only the permissions needed by the
declared resources, including Worker, D1, DNS, Zone WAF, and HTTP DDoS Managed Ruleset writes. Branch
protection on `trunk` must require the complete pull-request gate. The deployment workflow is a post-merge consequence, not a replacement for that gate.

Railway, PostgreSQL, and a Bun process are superseded Production architecture under
[ADR 0026](../adr/0026-cloudflare-native-production-replatform.md). Remove provider repository
integrations and deployment triggers for those systems; they are not recovery paths.

## Topology

- `https://app.fidyapp.com` serves the validated assets-only web artifact.
- `https://fidyapp.com` permanently redirects to the application while preserving path and query.
- `https://api.fidyapp.com` reaches the public ingress Worker.
- the Core Worker has no custom domain, route, or `workers.dev` URL and is reachable only through the
  ingress `CORE` service binding.
- ingress has no D1 binding.

`GET https://api.fidyapp.com/health` crosses the service binding and returns only `status`, the exact
release Git revision, and the canonical contract digest. The response is `no-store`. It does not
expose binding names, environment values, internal routes, exception text, or Secrets.

## Release sequence

The [Kapso real-user launch check](kapso-launch-readiness.md) is separate from ordinary MVP code deployments. The Free plan's indefinite WhatsApp retention is disclosed for the current MVP and must not be reported as a finite retention setting. Before broad real-user WhatsApp launch, run the check and complete the provider review; do not mistake a successful code deployment for launch approval. The workflow allows one active release and does not cancel an active deployment.

1. Check out the exact `github.sha` revision and install the locked workspace.
2. Calculate the canonical contract digest and bind it with `RELEASE_GIT_SHA` for later steps.
3. Create an ephemeral local Alchemy profile.
4. Run four parallel preflight lanes in the same runner: focused Worker-boundary tests, live Workers
   AI conformance, Production web build/validation, and Cloudflare state checks. The web artifact
   retains immutable release metadata, hashed assets, headers, and secret-free validation.
5. In the Cloudflare lane, compare Production's applied D1 migration names and hashes with checked-in
   SQL before bootstrapping; fail closed on any missing file, hash mismatch, incomplete history, or
   inability to query the ledger.
6. Only after the migration check succeeds, idempotently bootstrap the persistent Cloudflare state
   authority with `alchemy provider cloudflare bootstrap`, then reject topology drift. These three
   checks remain sequential.
7. Wait for every preflight lane to finish, failing the release if any lane failed. Runner cancellation
   terminates their process groups. Grouped logs retain each lane's outcome and elapsed seconds;
   GitHub step timing observes the complete barrier. No extra telemetry or provider payload capture
   is needed. Require the reviewed edge policy, then run
   `alchemy plan --stage production --no-input`. No planning or candidate upload can bypass the barrier.
8. Recheck trunk through the bounded Git reference response (not commit patches), then capture each
   active public/Core deployment and its sole stable 100% version. Independent public/Core capture
   reads overlap with concurrency capped at two;
   prove both stable identities through the reserved smoke path. Refuse an ambiguous deployment.
   Alchemy may retain a replacement receipt while old-generation cleanup is pending; use its current
   generation only when the Worker identity and rollout hash are present. For an interrupted update,
   capture may use its persisted output only when its Worker identity matches the last-applied output;
   this exception applies to capture only. Candidate staging and cleanup still require completed
   receipts. All other in-progress/incomplete receipts, missing baselines, ambiguous deployments, and
   identity mismatches block candidate upload.
9. Run `alchemy deploy --stage production --yes --no-input` with the same revision and digest.
   The capture step first requires existing Alchemy Worker hash state so the pinned provider cannot
   fall back to a direct 100% PUT. Alchemy owns the complete topology and uploads the public/Core
   immutable candidates with `version.traffic: 0`. This is **upload only**, not an active 0% deployment.
10. Read the exact candidate IDs from Alchemy's persisted Worker upload receipts. The checked-in
    routing controller uses Wrangler's 0% deployment primitive to install each candidate alongside
    its captured stable version (100%). It re-reads Cloudflare after each write. Never replace 0%
    with a nonzero percentage to accommodate a differing API schema.
11. Run `verify-production-smoke.ts` against the exact candidate pair **and** the old-public/new-Core
    pairing concurrently (at most two), using explicit version overrides and distinct synthetic probe
    IDs. Each probe owns its D1 status and Queue/Workflow identity; both use the same fixed, idempotent
    R2 marker and compatibility-only Durable Object check. Candidate edge rejection checks still
    follow successful candidate synthetic work. Both pairings and edge checks must succeed before
    any normal traffic changes. Failure interrupts the sibling's runner-side work, never qualifies a
    partial success as an attestation, and does not cancel already admitted platform work; its
    existing admission cap and five-minute expiry remain unchanged.
12. Recheck trunk and current deployment IDs before each promotion. Route the tested Core candidate
    to 100%, then the tested public candidate to 100%. No mutable tag or latest-version selector
    participates. Verify the redirect, static metadata, and bound health response afterward.
13. Retain the captured rollback receipt in a private, seven-day GitHub Actions artifact. Probe
    **normal traffic without version overrides** using the same synthetic smoke protocol. Retry a
    bounded three times for convergence; a confirmed failure attempts guarded code-only rollback,
    public first and then Core. A failed post-promotion probe fails the release even if code traffic
    was successfully restored. The failure email includes the observed traffic state.
14. Record the Git revision, contract digest, and stack identity in the GitHub step summary.

A superseded candidate reports:

```text
Release $RELEASE_GIT_SHA was superseded by $CURRENT_TRUNK_SHA; leaving the prior topology active.
```

Normal release [36645519165](https://github.com/B4rz99/fidy-ai/actions/runs/36645519165)
passed candidate and compatibility smoke, exact-pair promotion, normal-traffic probes,
public topology/unauthorized-edge checks, and both drift gates. Infrastructure state
was preserved. The obsolete direct smoke bootstrap, incident-specific Core recovery,
interrupted-upload resume, and fixed historical candidate probe have been retired.
Their incident evidence remains in [issue #725](https://github.com/B4rz99/fidy-ai/issues/725)
and the historical workflow runs, not executable recovery constants.

Use `Inspect Production Worker traffic` for read-only routing and drift evidence.
Unexpected drift blocks every release; there is no Worker-only exemption. A deployment
write is issued once; bounded reads may confirm its exact committed routing after a
lost response, but never justify repeating the write.

Proof-admitted smoke failures report only a closed `x-fidy-smoke-failure` stage, such as
`identity`, `configuration`, `schema`, `storage`, `coordinator`, or `publication`.
The runner validates this vocabulary before printing it and never retries a synthetic
smoke 503 or treats it as a passing gate. An unexpected private execution defect is classified as `platform`;
a downstream 503 without a valid owned diagnostic is classified as `core_response` and its
body is discarded. Neither classification establishes the root cause by itself. No provider error, secret, or User content enters diagnostics.
Failure alerts use the GitHub run ID and attempt as their idempotency identity, rather
than the revision: distinct runs of one revision can have different traffic reports.
[Resend documents](https://resend.com/docs/dashboard/emails/idempotency-keys) that reusing
a key with a different payload produces HTTP 409. This corrects the collision risk seen
in the failed resume; actual inbox delivery still needs verification.

After the original drift CLI rejects a plan, an additional dry-run inspection
reports only closed changed attribute names for these two Workers, including
upload-receipt fields. It is bounded to 45 seconds and cannot change the original
verdict. Unknown keys become `other`; attribute values and provider text remain
private. No provider method is wrapped and no repair API is invoked. The SDK
runner is an explicit platform entrypoint: its narrowly scoped compiler overrides
accommodate Alchemy's `any`-typed failure channel and the entrypoint Layer, while
all failures are contained and the returned plan crosses a closed Schema before
reporting. No provider result, persisted state, or drift gate changes.

Inspection [36640476836](https://github.com/B4rz99/fidy-ai/actions/runs/36640476836)
identified exactly `versionId` drift on both Core and Ingress, while the promoted
pair remained at 100%. A regression against the installed Alchemy Worker reader
reproduced that same difference with otherwise matching Cloudflare responses.
Alchemy defines this field as the latest gradual-rollout upload receipt, not the
current traffic deployment. The pinned `alchemy@2.0.0-beta.79` Bun patch retains
that receipt only after `GET` verifies the immutable version still exists. A
missing version still produces drift; unrelated live configuration changes remain
observable. Both source and distributed JavaScript are patched because Bun and
Node/Vitest resolve different package conditions. No saved record or traffic is
rewritten by this fix. The SDK adapter test has only a file-scoped upstream
`any`-error-channel exception, guarded by the exact compiler-exception allowlist.
The patch resolved both drift gates in the green normal release above. The upstream
fix is tracked by [Alchemy #1900](https://github.com/alchemy-run/alchemy/issues/1900)
and [PR #1901](https://github.com/alchemy-run/alchemy/pull/1901). Remove the patch only
when a locked upstream release passes these regression tests. Onboarding enablement
remains paused and requires the separate launch proof.

Before candidate smoke, the runner polls both new-public/new-Core and old-public/new-Core
readiness concurrently and waits for both before starting either synthetic probe. Before the
normal post-promotion smoke, it polls the promoted pair. These checks use proof-admitted
`GET /internal/release-smoke?readiness=1` for exact public/Core identities.
This response is identity-only (`pending`), not a passing synthetic attestation. It performs
no D1 read/admission, R2/DO check, Queue send, or Workflow creation. A bounded readiness
failure blocks the release before any synthetic work. Candidate readiness uses both version
overrides (with the captured stable public version for intermediate readiness); post-promotion
readiness uses normal traffic with no overrides. Only after this read-only convergence does the
existing synthetic protocol run with its unchanged gates. Readiness exhaustion identifies the
pairing and last closed diagnostic; decoded identity mismatches report only per-field equality
booleans, never response bodies or foreign text. Synthetic failures also identify their pairing.
Runs 37019952565, 37020598487, 37021188674, and 37022270459 passed candidate-only readiness but
failed synthetic smoke with `stage=identity`. Those logs establish a Core identity mismatch,
not which pairing or identity field failed. The two-pair readiness barrier closes the untested
intermediate-routing gap; a live release is still required to determine whether that gap explains
the incident or whether routing remains persistently incorrect.
[Cloudflare documents](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/version-overrides/)
that a recent deployment can briefly fall back to normal traffic even when an override is sent.
This addresses the observed wrong-public-version attempt; it does not establish that every
previous HTTP 503 had the same cause.

Readiness does not guarantee the next request uses the override. During pinned candidate or
intermediate synthetic POSTs, the runner also replays a Core `identity` rejection only when the
public version is the expected one and the response is `no-store`. Core rejects this request before
D1 admission, binding checks, or publication. Replays keep the exact probe body and share the
existing seven-attempt, 1.5-second-spacing bound with public-version fallback retries. A persistent
mismatch still fails; normal-traffic probes, transport/authority errors, and failures after admission
are never retried by this rule. Proof-admitted identity failures carry only three equality bits
(Core version/revision/digest), decoded by ingress and printed as booleans by the runner. Observed
identity values and foreign text never enter the ordinary smoke verdict. This tolerates a transient pre-admission
routing race without proving that such a race caused every historical failure.

For the recurring identity failure, the protected release runs `diagnose-smoke-routing.ts` after
staging and again before pairing smoke. The latter waits a fixed 60 seconds before sampling,
distinguishing early selection from settled selection without changing retry bounds. It requires all
48 ordinary Request/paired-override samples to report the exact candidate Core and the expected
candidate or captured stable ingress, across six rounds, both methods and two replicas. Slots must be
complete and unique; status, identity source and actual call form must match the read-only protocol.
Missing or mismatched evidence blocks synthetic work and promotion; cleanup restores the stable pair.
The other call/dictionary variants remain diagnostic controls, not promotion authority.
Six rounds use the same readiness URL, with two replicas of each GET/POST control. Candidate requests
compare the existing Request service-binding call with the documented URL/options form; method,
headers, body, destination and cancellation signal remain the same. Proof-admitted ingress reports
which call it actually used; an older ingress reports `unavailable`, never an assumed call form.
Intermediate requests compare paired overrides with a Core-only override. Core-only requests rely
on the still-100%-stable public deployment; their observed public identity must be checked against the
captured stable version. Each round has 16 concurrent requests (96 per sampling window).
GET observes identity only. POST supplies the reserved all-zero Git revision and is rejected before
admission, binding checks or publication—even in local zero-revision configuration. Older Production
Core code also rejects it because its configured revision is nonzero. The runner caps each request
at eight seconds, the run at 125 seconds (including settling) and streamed GET responses at 4 KiB;
redirects and automatic HTTP tracing are disabled. Output contains only method, pairing, round,
replica, requested/observed call form, override form, observation window, status, validated public/Core
version IDs and identity source. New Core rejection headers carry a validated version ID; older Core
can be identified by true equality against the captured stable version, marked `equality`, never
assumed from a fallback. Missing/malformed identity remains `unavailable` and cannot satisfy the
settled gate. Observations are not synthetic-work attestations and cannot authorize promotion;
ordinary readiness and synthetic gates still run afterward.

The [Cloudflare version-override contract](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/)
supports explicit overrides through service-binding `fetch` calls and warns that unapplied overrides
fall back to deployment percentages. Our ingress already forwards that header explicitly. The open
[Workers SDK report #15536](https://github.com/cloudflare/workers-sdk/issues/15536) describes a similar
0%-version override failure, but has no confirmed platform cause. Matching symptoms are supporting
context, not proof that Fidy has the same bug. Run 37048560756 confirmed per-request and time-varying
selection; it did not establish that HTTP method caused the divergence. Controlled run
[37052790175](https://github.com/B4rz99/fidy-ai/actions/runs/37052790175) found early fallback in both
GET and POST and both Request and URL/options call forms; removing the public dictionary entry did
not eliminate it either. After a fixed minute, all candidate samples selected the correct pair.
This supports a convergence race and motivates the settled gate, not a claim that a fixed wait alone
makes overrides reliable. The gate continues to fail closed if routing has not converged.

Never deploy a mutable tag, a later checkout, or provider-controlled source. Production has no
persistent staging sibling. The stack rejects missing, malformed, and all-zero Production release
metadata before creating resources.

## D1 migration history

Treat every SQL migration as immutable once its name appears in Alchemy's `__alchemy_migrations`
ledger. PR validation rejects edits, deletions, and renames of existing migrations; add a new
forward-only migration for an already-applied schema change. If a migration failed before being
recorded and must be corrected in place, run **Verify unapplied D1 migration repair** from `trunk`
with the PR number and the original migration filename. The protected `production` environment
checks that exact migration against Production and issues a commit-status approval only while it is
unapplied. PR workflows receive no Cloudflare credentials. PR validation accepts that approval
only when its verification began after the latest Production workflow run completed; an overlapping
or newer Production run makes the approval stale, so rerun the repair workflow after a release. The
deploy workflow independently rechecks every applied migration hash before bootstrapping or
planning, so an earlier approval cannot bypass current Production history.

The GitHub `production` environment must use a custom deployment-branch policy that allows only the
protected `trunk` branch. The dispatch workflow's YAML branch guard is defense in depth; the
Environment restriction prevents a feature-branch workflow definition from accessing Production
secrets.

The applied-history check is observable through the Production workflow run: GitHub Actions records
the step duration and sanitized output. On failure, output identifies only the stage that could not be
verified—Alchemy resource-state lookup, D1 ledger query, checked-in SQL read or hash, or history
comparison—without provider output or resource values. A non-zero result blocks bootstrap, planning,
and deployment. The check runs synchronously once per workflow, performs reads only, and has no
retries or background continuation, so workflow status, step timing, and logs are sufficient without
separate metrics or tracing. Never include raw provider output or credentials in those logs.

### Expand-and-contract changes

Add schema and resource capacity before code depends on it; keep the stable and candidate Worker
versions compatible during 0%-traffic smoke and any code-only rollback. Use a new migration for a
changed applied schema. Do not drop old columns, remove bindings, rename Workflow definitions, or
change Durable Object lifecycle in the same release that starts using their replacements. Those
changes require a separately reviewed rollout and a fix-forward recovery plan. D1 read replication
stays disabled for authorization and immediate post-mutation reads.

## Local parity and smoke checks

Start the same topology locally:

```sh
bun run dev
```

Alchemy assigns the declared local URLs and injects the ingress origin into Vite while retaining the
ingress-to-Core service binding. This is the representative local runtime; starting the web package
alone is useful UI work but does not prove the Cloudflare topology. The local-emulation acceptance
starts this same CLI stack and probes both browser wiring and bound health.

After deployment, verify the redirect, static host, metadata, and bounded health response:

```sh
curl --fail --silent --dump-header - https://fidyapp.com/auth/pair --output /dev/null
curl --fail --silent --dump-header - https://app.fidyapp.com/auth/pair --output /dev/null
curl --fail --silent https://app.fidyapp.com/deployment-metadata.json | jq
curl --fail --silent https://api.fidyapp.com/health | jq
```

The shell and SPA fallbacks use `no-cache`; hashed assets use the immutable cache policy. Confirm the
checked-in CSP, opener/resource isolation, permissions, referrer, MIME-sniffing, and frame-denial
headers on representative routes.

## Exact-version smoke contract (#718)

`bun infra/cloudflare/verify-production-smoke.ts` is the candidate-only gate consumed by the
zero-traffic release controller (#719). It requires `PUBLIC_VERSION_ID`, `CORE_VERSION_ID`,
`PUBLIC_WORKER_NAME`, `CORE_WORKER_NAME`, `RELEASE_GIT_SHA`, `CONTRACT_DIGEST`, and the
production-environment `SMOKE_PROOF` secret. Provision the same independent, randomly generated
64-character lowercase hex secret to the public Worker and Core Worker as a secret binding.
Never print it or add it to a URL, log, artifact, or summary. The controller must obtain the
version IDs from Cloudflare's upload results, not a health response, and must stop without
promotion if this command fails. #719 uploads the candidates, installs 0% active routing, runs this gate, and guards promotion.
The gate also checks old public against new Core; this is the normal-traffic intermediate pairing
while Core is promoted first. The stable identity is captured before candidate upload, never inferred
from an unversioned response after it.

The runner sends a two-Worker version override, verifies each Worker's independently reported
version metadata, Git revision, canonical contract digest, and shared smoke manifest, then waits
for a dedicated no-op Queue/Workflow completion. It checks unauthenticated health and public
rejection responses against the candidate public version, and smoke telemetry reports only the
release identity and closed operation outcome. Admission is limited to eight active synthetic
probes at a time; replays cannot publish the same probe twice. Allow five minutes for older
probes to expire before retrying a saturated gate. Failed work for a claimed probe requires a
fresh probe ID. The reserved Durable Object check establishes compatibility with whichever
version Cloudflare assigned the object; Queue/Workflow completion establishes deployed wiring,
**not that the candidate's async code ran**. The synthetic D1 row expires after five minutes and
Core cron removes expired rows. The reserved R2 marker carries no User material.

## Failure and recovery

A failed build, test, plan, supersession check, or public-topology verification fails the release. If
deployment starts and fails, inspect the Alchemy plan/state and Cloudflare resource state before fixing
forward with a new trunk revision. Recovery remains a reviewed change through this GitHub Actions
workflow; do not deploy from a workstation, dashboard, provider source integration, Railway, or the
a separate preview deployment.

The assets Worker keeps the legacy physical name `fidy-web` and explicitly opts that resource into
Alchemy adoption, so the first Alchemy release updates the old Wrangler-managed Worker in place,
reconciles its custom domains, and disables both workers.dev surfaces. Adoption is scoped to this
known migration target; other resources retain Alchemy's fail-closed ownership checks. The post-deploy
exact-release probes fail if traffic still reaches the legacy artifact.

Candidate upload or smoke failure before promotion leaves both stable Worker versions at 100%.
The workflow removes only its own staged 0% versions after a pre-promotion failure; an unexpected
routing state refuses cleanup and alerts instead of overwriting another release. This also prevents
a failed 0% candidate from blocking the next trunk release's stable-state capture.
If public promotion fails after Core has changed, the controller checks that public still routes to
its captured stable deployment and that Core still routes to the just-promoted deployment before
restoring Core. An unknown result, racing change, or failed restoration requires operator inspection;
there is no atomic two-Worker traffic transaction. A failed release must not be reported as a full
rollback. In particular, D1 migrations, R2, Durable Object/Workflow state, Queue work, scripts other
than public/Core, and the web artifact may already have changed under Alchemy. Keep these changes
additive and compatible with stable Worker code, and fix forward through a reviewed trunk release.

### Immediate post-promotion code failure (#720)

The post-promotion probe exercises **unversioned normal traffic**, checking both independently
reported Worker version IDs, release identities, the smoke manifest, and synthetic Queue/Workflow
completion. Exact-version overrides are used only before promotion; they could conceal a routing
failure afterward. The probe cannot detect code paths it does not exercise or claim real-traffic
exception coverage. It is bounded by three attempts; a confirmed failure triggers the checked-in
rollback command, not an unreviewed deploy. No Tail Worker or paid-plan Tail feature is required.

Rollback accepts only the immutable public/Core stable IDs captured **before** candidate upload.
Both must appear in Cloudflare's `deployable=true` Worker version history (at most the most recent
100 versions are eligible). The version metadata must show unchanged bindings, Durable Object
migration tags **and lifecycle exports**; the Git diff from the captured stable revision must
show no D1 migration, Alchemy topology, or Queue/Workflow definition change. An absent Git revision, unknown version metadata,
changed secret/binding, Durable Object lifecycle change, or changed deployment **refuses** automatic
rollback. The Cloudflare deployment API is called without `force=true`; if Cloudflare rejects a
secret change or deleted resource, stop rather than bypass its safety check. These checks are
conservative eligibility evidence, not a general schema migration proof. Changes to a shared
resource outside reviewed Git deployment authority are unsupported and require operator inspection.

Before each traffic write, the controller checks the exact promoted deployment ID and its sole
100% candidate version. It restores public first (the stable-public/candidate-Core intermediate
pairing passed pre-promotion smoke), then Core, and confirms each resulting deployment. If any
read or write is uncertain, it stops and emails the observed traffic state; **do not infer a full
rollback from the attempt**. GitHub serializes release and manual fallback runs. Cloudflare's
create-deployment API does not expose an atomic deployment `If-Match`/compare-and-swap precondition:
an out-of-band deployment between the final read and write can still race. Restrict deployment
credentials to this coordinator and stop for operator action if a different writer is suspected.

The one-command manual fallback for an eligible recent release, using its Production workflow run ID:

```sh
gh workflow run production-rollback.yml --ref trunk -f release_run_id=<release-run-id>
```

The protected Production environment downloads that run's captured receipt, validates its trunk
Production-push origin and revision, and runs the **same guarded code-only** rollback. It cannot force an incompatible target
or overwrite a later deployment. Failed manual attempts email the operator with observed traffic;
watch its run and that alert. If it refuses, inspect
both observed deployments, resource history, and D1 schema, then fix forward through reviewed trunk.
The receipt artifact expires after seven days; an older release requires explicit operator planning,
not a guessed version. No workstation or dashboard deployment is an ordinary fallback.

**Prelaunch exercise — required before the first real User, not yet performed:** On the empty
Production stack, deliberately promote a candidate whose normal-traffic smoke fails while the
pre-promotion exact-version smoke passes. Record the candidate/stable deployment IDs, the failed
probe and confirmed restoration. Repeat with a controlled rollback refusal (for example, a
changed deployment ID) and verify the release-failure email contains the observed traffic state.
In another synthetic run, invoke the manual fallback command above and verify it restores the
captured pair. Record the workflow run IDs, Cloudflare response/version evidence, and operator
receipt privately; reset to a clean compatible baseline before admitting Users. Local tests cover
controller ordering/refusal and workflow wiring but **do not replace this remote exercise**.

Worker traffic rollback **does not restore** D1/R2/DO state, Queue contents, Workflow definitions
or instances, routes, configuration, secrets, web assets, or external effects. Keep schema and
resource changes additive and compatible with stable code; otherwise fix forward with explicit
operator action.

Cloudflare documentation: [Worker version rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/),
[deployable versions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/),
and [deployment create API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/).

For an incident, use the [Production recovery guide](production-recovery.md) to separate traffic,
state, provider outcomes, and operational evidence before choosing a response.

Never print, copy into metadata, or pass Cloudflare tokens as command arguments. Rotate a token in
Cloudflare and GitHub if exposure is suspected.
