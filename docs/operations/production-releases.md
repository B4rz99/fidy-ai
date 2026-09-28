# Production releases

GitHub Actions coordinates every Production release through
[`.github/workflows/production.yml`](../../.github/workflows/production.yml). Do not deploy from a
provider repository integration or from a workstation.

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
8. Read the current default-branch head immediately before deployment. If it differs from the release
   SHA, fail closed without starting the deployment.
9. Run `alchemy deploy --stage production --yes --no-input` with the same revision and digest.
10. Verify that the apex redirect, static metadata, and bound health response expose that exact release.
11. Record the Git revision, contract digest, and stack identity in the GitHub step summary.

A superseded candidate reports:

```text
Release $RELEASE_GIT_SHA was superseded by $CURRENT_TRUNK_SHA; leaving the prior topology active.
```

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
the step duration and its sanitized success or failure output, and a non-zero result blocks bootstrap,
planning, and deployment. The check runs synchronously once per workflow, performs reads only, and has
no retries or background continuation, so workflow status, step timing, and logs are sufficient
without separate metrics or tracing. Never include raw provider output or credentials in those logs.

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
promotion if this command fails. The current deployment workflow still deploys directly;
#719 owns candidate upload, 0% routing, invocation of this gate, and guarded promotion.

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
Core cron removes expired rows. The reserved R2 marker carries no User material. The first
release installing the smoke protocol must use the existing direct deployment path before a
stable version can answer the reserved Durable Object probe; later releases can use #719.

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

Never print, copy into metadata, or pass Cloudflare tokens as command arguments. Rotate a token in
Cloudflare and GitHub if exposure is suspected.
