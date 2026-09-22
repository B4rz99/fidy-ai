# Production releases

GitHub Actions coordinates every Production release through
[`.github/workflows/production.yml`](../../.github/workflows/production.yml). Do not deploy from a
provider repository integration or from a workstation.

## Authority and provider setup

`infra/cloudflare/alchemy.run.ts` is the sole Production topology authority. It declares the static
application, apex redirect, public ingress Worker, private Core Worker, service binding, and release
metadata bindings as one Alchemy stack. Remote stages other than `production` are rejected before
resource creation. `apps/web/cloudflare/wrangler.json` is restricted to static pull-request previews
and owns no Production route.

Create the GitHub `production` environment and configure:

| Kind     | Name                    | Purpose                                                |
| -------- | ----------------------- | ------------------------------------------------------ |
| Secret   | `CLOUDFLARE_API_TOKEN`  | Alchemy-managed Worker, custom-domain, and DNS changes |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account owning the Fidy resources           |

Scope the token to that account and the `fidyapp.com` zone, with only the Worker and DNS permissions
needed by the declared resources. Branch protection on `trunk` must require the complete pull-request
gate. The deployment workflow is a post-merge consequence, not a replacement for that gate.

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

The workflow allows one active release and does not cancel an active deployment.

1. Check out the exact `github.sha` revision and install the locked workspace.
2. Calculate the canonical contract digest and bind it with `RELEASE_GIT_SHA` for later steps.
3. Run the focused Worker-boundary tests.
4. Build and validate the Production web artifact, including immutable release metadata, hashed
   assets, headers, and secret-free contents.
5. Run `alchemy plan --stage production --no-input` from `infra/cloudflare`.
6. Read the current default-branch head immediately before deployment. If it differs from the release
   SHA, fail closed without starting the deployment.
7. Run `alchemy deploy --stage production --no-input` with the same revision and digest.
8. Verify that the apex redirect, static metadata, and bound health response expose that exact release.
9. Record the Git revision, contract digest, and stack identity in the GitHub step summary.

A superseded candidate reports:

```text
Release $RELEASE_GIT_SHA was superseded by $CURRENT_TRUNK_SHA; leaving the prior topology active.
```

Never deploy a mutable tag, a later checkout, or provider-controlled source. Production has no
persistent staging sibling. The stack rejects missing, malformed, and all-zero Production release
metadata before creating resources.

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

## Failure and recovery

A failed build, test, plan, supersession check, or public-topology verification fails the release. If
deployment starts and fails, inspect the Alchemy plan/state and Cloudflare resource state before fixing
forward with a new trunk revision. Recovery remains a reviewed change through this GitHub Actions
workflow; do not deploy from a workstation, dashboard, provider source integration, Railway, or the
preview Wrangler adapter.

The assets Worker keeps the legacy physical name `fidy-web` so the first Alchemy release updates the
old Wrangler-managed Worker in place, reconciles its custom domains, and disables both workers.dev
surfaces. The post-deploy exact-release probes fail if traffic still reaches the legacy artifact.

Never print, copy into metadata, or pass Cloudflare tokens as command arguments. Rotate a token in
Cloudflare and GitHub if exposure is suspected.
