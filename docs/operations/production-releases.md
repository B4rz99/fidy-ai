# Production releases

GitHub Actions coordinates every Production release through
[`.github/workflows/production.yml`](../../.github/workflows/production.yml). Do not deploy from a
provider repository integration or from a workstation.

## Provider setup

Create the GitHub `production` environment and configure only:

| Kind     | Name                            | Purpose                                    |
| -------- | ------------------------------- | ------------------------------------------ |
| Secret   | `CLOUDFLARE_API_TOKEN`          | Worker Versions upload and promotion       |
| Variable | `CLOUDFLARE_ACCOUNT_ID`         | Cloudflare account owning `fidy-web`       |
| Variable | `CLOUDFLARE_BOOTSTRAP_REQUIRED` | `true` only until the first Worker version |

The checked-in Wrangler configuration is the deployment authority. It currently uploads the validated
static web artifact and has no local-server, database, or provider-source deployment path. Future
Worker bindings must be added to that configuration and smoke-tested before they become production
authority.

Branch protection on `trunk` must require the complete pull-request gate. The deployment workflow is
a post-merge consequence, not a replacement for that gate.

## Release sequence

The workflow allows one active release and does not cancel an active deployment.

1. Check out the exact `github.sha` revision and install the locked workspace.
2. Build the production web artifact with `RELEASE_GIT_SHA` and validate its required files, digest,
   hashed assets, headers, and secret-free contents.
3. Run Wrangler's credential-free deployment dry run against the checked-in configuration.
4. If `CLOUDFLARE_BOOTSTRAP_REQUIRED=true`, bootstrap the static Worker once. Set it to `false` after
   the first successful deployment.
5. Upload exactly one immutable Cloudflare version tagged with the Git revision and capture its exact
   version id.
6. Read the current default-branch head. If it differs from the release SHA, fail closed and leave
   the prior active version untouched.
7. Promote only the captured version id.
8. Record the Git revision and Cloudflare version in the GitHub step summary.

The supersession check is deliberately immediately before promotion:

```text
Release $RELEASE_GIT_SHA was superseded by $CURRENT_TRUNK_SHA; leaving the prior version active.
```

An uploaded but unpromoted version is harmless and may be retained for provider-side cleanup. Never
promote a version selected by a mutable tag, a later checkout, or a provider repository integration.

## Artifact and smoke checks

`apps/web/cloudflare/production-policy/artifact.ts` accepts only the static shell, deployment
metadata, headers, and content-hashed browser assets. It rejects source maps, server-shaped paths,
secret material, and missing shell references. The production metadata and the workflow SHA must be
the same exact 40-character revision; the contract digest is checked against the generated artifacts.

After promotion, verify the public static host and metadata:

```sh
curl --fail --silent --dump-header - https://fidyapp.com/ --output /dev/null
curl --fail --silent --dump-header - https://fidyapp.com/auth/pair --output /dev/null
curl --fail --silent https://fidyapp.com/deployment-metadata.json | jq
```

The shell and SPA fallbacks use `no-cache`; hashed assets use the immutable cache policy. Confirm the
checked-in CSP, opener/resource isolation, permissions, referrer, MIME-sniffing, and frame-denial
headers on representative routes.

Cloudflare API, D1, Durable Objects, Queues, Workflows, R2, Workers AI, and Email Workers remain
separate adapter gates. A missing adapter must be observable as a typed unavailable result; it must
never be replaced by a local process, in-memory state, or a hidden fallback.

## Failure and recovery

A failed build, dry run, upload, or supersession check does not change active traffic. A failed
promotion leaves the previous Cloudflare version active. Fix forward with a new trunk revision or use
Cloudflare's immutable version history for an explicitly reviewed operational recovery.

Never print, copy into metadata, or pass Cloudflare tokens as command arguments. Rotate a token in
Cloudflare and GitHub if exposure is suspected.
