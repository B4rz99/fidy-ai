# ADR 0018: Independent Production deployments

- Status: Accepted
- Date: 2026-04-02

## Context

The workspace contains two applications with different runtime needs. `@fidy/server` is a long-lived
Bun process with migrations, queues, webhooks, and PostgreSQL access. `@fidy/web` is a Vite SPA whose
output is static files. They share one source revision, but putting both in one image would couple
otherwise independent runtime and recovery boundaries.

The canonical `FidyApi` belongs to the server. The web consumes only the browser-safe
`@fidy/server/client` declaration seam. Moving declarations into a shared contract package would
create a second owner and would not prove runtime compatibility.

## Decision

Railway runs the server image and Cloudflare serves the static web artifact. GitHub Actions is the
sole Production release coordinator. On every accepted trunk revision it:

1. asks Railway's public API to deploy that exact connected-repository commit;
2. waits for Railway success and verifies `/health` reports the expected full Git revision and
   canonical contract digest;
3. builds and validates the static web artifact with the same identity;
4. uploads one immutable Cloudflare version;
5. rechecks that the revision is still trunk head, then promotes only the captured version ID.

The server image contains no web source or output. The Cloudflare upload contains no server
implementation, source maps, or Secrets. `fidyapp.com` is the Cloudflare Production custom domain;
`api.fidyapp.com` is the Railway API origin and the web CSP's only network destination.

Contract-changing releases use an add/use/remove sequence: deploy a server that temporarily accepts
both shapes, deploy the web that uses the new shape, and remove the old shape only in a later
release. The checked-in canonical artifacts define the contract digest embedded in both
applications.

## Failure and recovery

The release is fail-stop, not transactional across providers. A server failure prevents any web
upload. A web build, upload, supersession, or promotion failure leaves the prior Cloudflare version
active; the successfully deployed backward-compatible server may remain active. Recovery uses the
providers' version histories or a new trunk revision. There is no custom rollback coordinator,
staging environment, required manual approval, GHCR handoff, attestation service, or long-lived
promotion platform.

Railway automatic Git deployment and every provider-controlled Cloudflare source deployment are
disabled. Provider configuration remains runtime configuration, while GitHub Actions owns release
ordering.

## Rejected alternatives

- **One Railway deployment serving the SPA:** couples static delivery and API recovery, expands the
  server image, and obscures the browser/server boundary.
- **A shared contract package:** introduces a second contract owner instead of deriving the client
  from `FidyApi`.
- **Cloudflare Worker backend:** unnecessary; Cloudflare hosts only static assets.
- **Cross-provider rollback:** cannot be atomic and adds machinery without improving compatibility.
