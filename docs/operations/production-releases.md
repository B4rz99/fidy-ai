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
3. Run the focused Worker-boundary tests.
4. Build and validate the Production web artifact, including immutable release metadata, hashed
   assets, headers, and secret-free contents.
5. Create an ephemeral local Alchemy profile.
6. Compare Production's applied D1 migration names and hashes with checked-in SQL before bootstrapping
   or planning; fail closed on any missing file, hash mismatch, incomplete history, or inability to
   query the ledger.
7. Idempotently bootstrap the persistent Cloudflare state authority with
   `alchemy provider cloudflare bootstrap`, reject topology drift, and run
   `alchemy plan --stage production --no-input`.
8. Recheck trunk, then capture each active public/Core deployment and its sole stable 100% version;
   prove both stable identities through the reserved smoke path. Refuse an ambiguous deployment.
   Alchemy may retain a replacement receipt while old-generation cleanup is pending; use its current
   generation only when the Worker identity and rollout hash are present. For an interrupted update,
   capture may use its persisted output only when its Worker identity matches the last-applied output;
   this exception applies to capture only. Candidate staging and cleanup still require completed
   receipts. All other in-progress/incomplete receipts, missing baselines, ambiguous deployments, and
   identity mismatches block candidate upload.
   **One-time smoke bootstrap:** Production still has the pre-smoke `b71c2248` Worker pair.
   The normal capture cannot call a smoke path that this pair does not implement. Once the
   reviewed bootstrap change is on `trunk`, dispatch `Deploy Production` with `bootstrap=true`
   from `trunk`. This protected run first requires that exact pre-smoke revision and contract
   digest on `/health`, captures both sole 100% Cloudflare deployments, and rechecks trunk.
   Only this dispatch omits `version.traffic: 0`: Alchemy deploys the new Core and public
   Workers directly. It then verifies the exact new stable identities using the protected
   smoke endpoint, waits for synthetic Queue/Workflow completion, and runs the normal public
   topology and edge probes. This first cutover cannot prove the old-public/new-Core smoke
   pairing or guarantee automatic rollback; on partial failure, inspect both deployments and
   fix forward through reviewed Production authority. Do not rerun the bootstrap after the
   stable revision changes; subsequent trunk pushes use the normal candidate path. The
   dispatch command is:

   ```sh
   gh workflow run production.yml --ref trunk -f bootstrap=true
   ```

9. Run `alchemy deploy --stage production --yes --no-input` with the same revision and digest.
   The capture step first requires existing Alchemy Worker hash state so the pinned provider cannot
   fall back to a direct 100% PUT. Alchemy owns the complete topology and uploads the public/Core
   immutable candidates with `version.traffic: 0`. This is **upload only**, not an active 0% deployment. The protected one-time bootstrap above establishes the first smoke-capable stable pair through a direct Alchemy deployment.
10. Read the exact candidate IDs from Alchemy's persisted Worker upload receipts. The checked-in
    routing controller uses Wrangler's 0% deployment primitive to install each candidate alongside
    its captured stable version (100%). It re-reads Cloudflare after each write. Never replace 0%
    with a nonzero percentage to accommodate a differing API schema.
11. Run `verify-production-smoke.ts` against the exact candidate pair **and** the old-public/new-Core
    pairing using explicit version overrides. Both must succeed before any normal traffic changes.
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

After run `36588418380` failed at Core-first promotion, inspection `36594005666` confirmed
public stable at 100% and Core candidate at 100% (the middle pair passed compatibility smoke).
The one-time protected `Recover interrupted Production Core promotion` dispatch restores only the
inspected prior Core version, after requiring the exact public/Core deployment IDs, live health and
smoke identity, unchanged Worker source, and current trunk. Its final check proves the original
public/Core stable pair. Do not run it if inspection shows any different traffic; use the read-only
`Inspect Production Worker traffic` workflow first. Both workflows serialize with deployment. The interrupted upload left Alchemy receipts for the
unpromoted candidate versions while both stable Workers were restored. Normal pushes still refuse
this Worker-only drift before upload. After inspection proves **only** `Core` and `Ingress` have
update drift, dispatch `Deploy Production` from `trunk` with `resume=true` and `bootstrap=false`.
The first resume (`36602097827`) stopped at candidate smoke before promotion. Cleanup restored
public stable traffic but could not confirm its write before removing the Core candidate. The next
resume is limited to public deployment `e6a6fcdc-a14e-4560-b360-3cdb6d3b6421` at stable 100%, and Core
deployment `17e36514-375e-4517-8c8e-beca709a863b` at stable 100% plus candidate 0%, with the exact
persisted candidate receipts from that run. It proves the normal stable smoke identities, accepts
only the two inspected Worker updates, rechecks trunk and both deployments, and removes only the
known zero-traffic Core candidate. Cleanup polls stale reads without repeating a committed write;
unknown deployments stop immediately. It then recaptures the sole stable pair before candidate upload. It then follows the ordinary zero-traffic candidate, pairing smoke, and guarded
promotion steps. Any other drift, receipt, or Worker identity fails closed.

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
Core cron removes expired rows. The reserved R2 marker carries no User material. The one-time smoke bootstrap uses the direct deployment path before a stable version can answer
the reserved Durable Object probe; later releases use #719.

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
