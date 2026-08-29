# Production releases

GitHub Actions coordinates every Production release through
[`.github/workflows/production.yml`](../../.github/workflows/production.yml). Do not deploy either
application from a provider's repository integration or from a workstation.

## Provider setup

Create the GitHub `production` environment without required reviewers. Configure:

| Kind     | Name                                | Purpose                                   |
| -------- | ----------------------------------- | ----------------------------------------- |
| Secret   | `RAILWAY_API_TOKEN`                 | Railway public GraphQL API authentication |
| Secret   | `CLOUDFLARE_API_TOKEN`              | Worker Versions upload and deployment     |
| Variable | `RAILWAY_PROJECT_ID`                | Railway project containing Production     |
| Variable | `RAILWAY_SERVICE_ID`                | Connected `@fidy/server` Railway service  |
| Variable | `RAILWAY_ENVIRONMENT_ID`            | Railway Production environment            |
| Variable | `PRODUCTION_API_ORIGIN`             | Exact `https://api.fidyapp.com` origin    |
| Variable | `CLOUDFLARE_ACCOUNT_ID`             | Account owning `fidy-web` and public DNS  |
| Variable | `PRODUCTION_DNS_ZONE`               | Exact `fidyapp.com` Cloudflare zone       |
| Variable | `PRODUCTION_API_CNAME_TARGET`       | Railway target for the API custom domain  |
| Variable | `PRODUCTION_API_VERIFICATION_NAME`  | Railway ownership-proof record name       |
| Variable | `PRODUCTION_API_VERIFICATION_VALUE` | Railway ownership-proof record value      |
| Variable | `RESEND_INGEST_MX_TARGET`           | Resend Receiving MX target                |
| Variable | `RESEND_INGEST_DKIM_NAME`           | Resend-provided DKIM record name          |
| Variable | `RESEND_INGEST_DKIM_VALUE`          | Resend-provided DKIM public value         |
| Variable | `RESEND_INGEST_SENDING_MX_TARGET`   | Resend sending MAIL FROM MX target        |
| Variable | `RESEND_INGEST_SPF_VALUE`           | Resend-provided SPF value                 |
| Variable | `CLOUDFLARE_BOOTSTRAP_REQUIRED`     | `true` only until first Worker deployment |

In Railway, keep `apps/server/railway.json` as the config-as-code path and the repository root as the
source root. Keep the GitHub source connected but disable automatic deployments for every service.
The workflow briefly enables the server trigger only around its explicit request, disables it again
before polling, and rejects any deployment whose `commitHash` is not the workflow's exact trunk
revision. Do not replace this with `railway up`, because that uploads mutable local content rather
than selecting repository state. The server's `/health` check replaces the former Railway
`health-cron` service; do not recreate that service.

Set `CLOUDFLARE_BOOTSTRAP_REQUIRED` to `true` for the first release so the workflow can provision
`fidy-web`, then immediately set it to `false` after that release succeeds. Bind the Production custom
domain to `fidyapp.com` and disable provider-controlled source deployments. The checked-in Wrangler
adapter has static assets and SPA fallback only; it has no Worker entrypoint.

Branch protection on `trunk` must continue to require the complete pull-request gate. The deployment
workflow is a post-merge consequence, not a replacement for that gate.

## Release sequence

The workflow allows one active release. GitHub does not cancel an active deployment; a newer push may
replace an older pending run.

1. Calculate the digest of the checked-in canonical contract artifacts.
2. Confirm that the event SHA is still the current trunk revision, reconcile the direct Cloudflare
   CNAME and Railway ownership-proof records for `api.fidyapp.com`, then invoke the connected Railway
   trigger with automatic deployment enabled only for that bounded request.
3. Accept only a new deployment whose provider metadata names that exact SHA. Railway
   runs image build, Sentry release preparation, runtime-role provisioning, migrations, and its
   `/health` check.
4. Poll Railway to a successful terminal status, then require public `/health` to report that full
   SHA and digest.
5. Build the web with `https://api.fidyapp.com`, write `/deployment-metadata.json`, reject any
   unhashed or missing shell asset, non-static, server-shaped, source-map, or known Secret material,
   then run Wrangler's credential-free deployment dry run against the static-only adapter.
6. If `CLOUDFLARE_BOOTSTRAP_REQUIRED` is explicitly `true`, create the static Worker with the exact
   release artifact. Set the variable to `false` immediately after that first deployment succeeds.
7. Upload one immutable Cloudflare version and capture the exact version ID from Wrangler.
8. Read the current default-branch head. If the release was superseded, stop and leave the current
   Cloudflare deployment active. Otherwise promote only the captured version ID.

The server embeds the contract digest during its build and obtains its revision from Railway's
immutable `RAILWAY_GIT_COMMIT_SHA`. The public diagnostics are:

```sh
curl --fail --silent https://api.fidyapp.com/health | jq
curl --fail --silent https://fidyapp.com/deployment-metadata.json | jq
```

Both must report the same 40-character `gitRevision` and 64-character `contractDigest`.

## Route and response verification

Cloudflare owns `/`, `/auth/pair`, `/app/transactions`, all other SPA fallbacks, and `/assets/*` on
`fidyapp.com`. Railway owns `/health`, `/openapi.json`, canonical routes such as `/user`, WebAuth
routes under `/web/*`, and provider webhooks on `api.fidyapp.com`; it must return 404 for `/` and web
page paths. A successful smoke therefore proves both positive and negative ownership rather than
merely proving that each host responds.

Every Cloudflare response inherits the checked-in CSP, opener/resource isolation, permissions,
referrer, MIME-sniffing, and frame-denial policy. SPA shells and `/deployment-metadata.json` use
`Cache-Control: no-cache`. The `/assets/*` rule explicitly removes that inherited value before
setting `public, max-age=31536000, immutable`; do not add overlapping cache rules because Cloudflare
joins duplicate header values.

After release, verify representative ownership and cache behavior:

```sh
curl --fail --silent --dump-header - https://fidyapp.com/auth/pair --output /dev/null
curl --fail --silent --dump-header - https://fidyapp.com/app/transactions --output /dev/null
curl --fail --silent https://api.fidyapp.com/openapi.json | jq -r .openapi
curl --silent --output /dev/null --write-out '%{http_code}\n' https://api.fidyapp.com/
curl --silent --output /dev/null --write-out '%{http_code}\n' https://api.fidyapp.com/auth/pair
```

The two API ownership probes must print `404`. Inspect the built shell for its hashed script path and
confirm that path returns the immutable cache policy while the shell returns `no-cache`. The cohesive
local proof uses separate trusted HTTPS origins, the production Vite mode and Cloudflare header file,
and real PostgreSQL:

```sh
docker compose up -d db
bun run --cwd apps/web test:browser -- e2e/browser-pairing-postgres.spec.ts
```

It covers SPA fallback and security/cache headers, API/OpenAPI/WebAuth separation, exact-origin
credentialed browser pairing, a host-only WebSession cookie, one-time redemption and replay refusal,
logout/expiry, and real Categories/Transactions presentation. The acceptance control listens only on
loopback and may reset or arrange PostgreSQL state; it is not a Production route.

## Failure and recovery

Use the GitHub run summary to correlate the Git SHA, Railway deployment ID, and Cloudflare version
ID. Inspect Railway build, pre-deploy, migration, and runtime logs before retrying a server failure.
A failed server release never reaches the web build.

A web failure leaves the prior Cloudflare version active. A superseded run can leave an unpromoted
version in Cloudflare; this is harmless and preserves evidence. Do not roll back the newly deployed
server merely because web promotion failed: add/use/remove compatibility requires that server to
remain compatible with the prior web. Fix forward with a trunk commit, or use the provider's native
version history only for an immediate operational recovery.

Never print, copy into metadata, or pass provider tokens as command arguments. Rotate a token in its
provider and GitHub environment if exposure is suspected.
