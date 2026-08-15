# Pull-request previews

Eligible same-repository pull requests publish the portable web artifact through Cloudflare Workers
Static Assets. Fork pull requests receive the ordinary credential-free checks but no deployment.
There is no preview API, database, authenticated session, custom domain, Worker entrypoint, or
Cloudflare GitHub integration.

## Trust boundary

`.github/workflows/ci.yml` builds `apps/web/preview.tar` only after `Required Checks` succeeds. That
workflow has no Cloudflare credential. The base-branch-owned `Publish PR Preview` workflow then:

1. confirms the pull request is still open, belongs to this repository, and still has the triggering
   head SHA;
2. calculates the canonical contract digest from the generated contract files at that exact SHA by
   calling the repository's canonical digest implementation;
3. downloads only the exact run's artifact;
4. independently validates the archive with trusted base-branch code and safely extracts only the
   allowed static files; and
5. rechecks the pull request immediately before pinned Wrangler uploads the version under
   `pr-<number>`.

The validator rejects unsafe paths, links and special files, duplicate or oversized entries,
source maps, Worker entrypoints, deployment configuration, server/Production/Secret material,
unexpected file types, substituted headers, and mismatched Git or contract identity. Client
JavaScript is necessarily PR-controlled static content, so no validator can infer the original
meaning of deliberately renamed minified code. The enforceable boundary is layered instead:
credential-free CI cannot introduce repository or Production Secrets; browser-graph checks reject
imports from server implementations; the archive policy rejects server/configuration shapes and
sensitive markers; and the preview CSP prevents network connections. The privileged workflow never
checks out or executes pull-request code, dependencies, Actions, configuration, or Wrangler
binaries.

## GitHub configuration

- Repository variable `CLOUDFLARE_ACCOUNT_ID`: the account containing `fidy-web`.
- Actions secret `CLOUDFLARE_API_TOKEN`: a token with `Account / Workers Scripts / Edit`, restricted
  to that specific account.

Cloudflare does not provide preview-only token scope. Do not add Zone, DNS, Workers Routes, KV, R2,
D1, Queues, or Access authority. If a future pinned Wrangler demonstrably requires another read
permission, review and add only that permission.

## Hosting behavior

`apps/web/cloudflare/wrangler.json` has no `main`; Cloudflare generates the static-asset serving
layer. Preview builds alone receive the adapter-owned `_headers` policy. It blocks all browser
connections with `connect-src 'none'`, denies framing and indexing, revalidates the HTML shell, and
caches fingerprinted assets immutably. Cloudflare's SPA fallback serves `index.html`, after which the
real TanStack Router preserves `/`, `/politica`, and application not-found behavior.

Preview aliases are public and no-index. Cloudflare's native rolling version retention is the
lifecycle policy; there is no close-event environment reconciler. The former `fidy-landing` Vercel
project Git connection was disconnected when this workflow was introduced, so repository pushes no
longer create Vercel previews.

## Observation and recovery

GitHub's bounded workflow job is the observation boundary: step logs, duration, failure status, and
manual rerun records cover latency, failures, and retries without separate telemetry. Deployment has
no durable continuation to observe; an interrupted upload fails the job and a current pull request
can be rerun. Each failure is reported once by GitHub rather than duplicated into application
telemetry.

## Local checks

Build and validate the exact current revision without Cloudflare credentials:

```sh
PREVIEW_GIT_SHA=$(git rev-parse HEAD) bun run --cwd apps/web build:preview
bun run test:preview-policy
```

Wrangler configuration can be checked without uploading:

```sh
bunx wrangler@4.123.0 deploy --config apps/web/cloudflare/wrangler.json --dry-run
```
