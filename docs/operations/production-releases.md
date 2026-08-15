# Production releases

GitHub Actions coordinates every Production release through
[`.github/workflows/production.yml`](../../.github/workflows/production.yml). Do not deploy either
application from a provider's repository integration or from a workstation.

## Provider setup

Create the GitHub `production` environment without required reviewers. Configure:

| Kind     | Name                     | Purpose                                   |
| -------- | ------------------------ | ----------------------------------------- |
| Secret   | `RAILWAY_API_TOKEN`      | Railway public GraphQL API authentication |
| Secret   | `CLOUDFLARE_API_TOKEN`   | Worker Versions upload and deployment     |
| Variable | `RAILWAY_SERVICE_ID`     | Connected `@fidy/server` Railway service  |
| Variable | `RAILWAY_ENVIRONMENT_ID` | Railway Production environment            |
| Variable | `PRODUCTION_API_ORIGIN`  | Exact `https://api.fidyapp.com` origin    |
| Variable | `CLOUDFLARE_ACCOUNT_ID`  | Account owning `fidy-web`                 |

In Railway, keep `apps/server/railway.json` as the config-as-code path and the repository root as the
source root. Disable automatic deployments from GitHub; the workflow calls Railway's public API with
an exact `commitSha`. Do not replace this with `railway up`, because that uploads mutable local
content rather than selecting the connected repository revision.

Provision `fidy-web` in Cloudflare before the first release, confirm Worker Versions are enabled, and
bind its Production custom domain to `fidyapp.com`. Disable provider-controlled source deployments.
The checked-in Wrangler adapter has static assets and SPA fallback only; it has no Worker entrypoint.

Branch protection on `trunk` must continue to require the complete pull-request gate. The deployment
workflow is a post-merge consequence, not a replacement for that gate.

## Release sequence

The workflow allows one active release. GitHub does not cancel an active deployment; a newer push may
replace an older pending run.

1. Calculate the digest of the checked-in canonical contract artifacts.
2. Ask Railway to build and deploy the exact event SHA. Railway runs image build, Sentry release
   preparation, runtime-role provisioning, migrations, and its `/health` check.
3. Poll Railway to a successful terminal status, then require public `/health` to report that full
   SHA and digest.
4. Build the web with `https://api.fidyapp.com`, write `/deployment-metadata.json`, and reject any
   non-static, server-shaped, source-map, or known Secret material.
5. Upload one immutable Cloudflare version and capture the exact version ID from Wrangler.
6. Read the current default-branch head. If the release was superseded, stop and leave the current
   Cloudflare deployment active. Otherwise promote only the captured version ID.

The server embeds the contract digest during its build and obtains its revision from Railway's
immutable `RAILWAY_GIT_COMMIT_SHA`. The public diagnostics are:

```sh
curl --fail --silent https://api.fidyapp.com/health | jq
curl --fail --silent https://fidyapp.com/deployment-metadata.json | jq
```

Both must report the same 40-character `gitRevision` and 64-character `contractDigest`.

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
