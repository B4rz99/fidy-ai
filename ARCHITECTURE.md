# Architecture

---

## 1. System shape

The repository root is a private Bun workspace. It owns the single lockfile, CI, shared compiler
policy, repository-wide quality policy, and stable orchestration commands. Root commands deliberately
delegate application work to its owning workspace package: this gives contributors and automation one
repository entrypoint while keeping runtime dependencies and behavior inside the application that
owns them.

The workspace contains exactly two application packages:

- [`@fidy/server`](apps/server/ARCHITECTURE.md) is the API, domain, persistence, hosted-agent, and
  provider application.
- [`@fidy/web`](apps/web/ARCHITECTURE.md) is the portable React/Vite browser application.

The directory boundary is intentional. It is enforced by lint and dependency checks so a naming
convention cannot be mistaken for an application boundary. A feature may touch both applications;
that cost is accepted in exchange for a structural boundary that survives refactoring and independent
agent sessions.

## 2. Cross-application contract

The server declares the canonical operation surface and owns its OpenAPI and complete reflected
operation-policy artifacts under `apps/server/contracts/`. Those artifacts are deterministic review
evidence, never another declaration. The server exposes one browser-safe `@fidy/server/client`
declaration seam. The web application derives its typed Effect Atom client from that declaration and
never owns a copied contract or imports server implementations.

The root TypeScript project-reference build expresses the server-before-web declaration dependency.
The mandatory root gate checks artifact freshness and compares the server-owned artifacts with the
pull-request base. A policy break requires an acknowledgement bound to the exact base digest,
candidate digest, finding set, and coordinated rollout issue. See
[Contract compatibility](docs/contract-compatibility.md) for the artifact lifecycle and the one-time
base bootstrap used by the architecture change that introduced it.

Every public API and agent surface derives from the server's canonical operation definition. A shape
that differs from a canonical shape is derived from it rather than maintained as a parallel contract.

## 3. Production topology

[ADR 0018](docs/adr/0018-independent-production-deployments.md) makes the application boundary a
runtime boundary. Railway builds and runs only the server image at `api.fidyapp.com`; Cloudflare serves
only the validated static web output at `fidyapp.com`. Cloudflare has no Worker entrypoint and the API
has no web route or static-file route.

GitHub Actions is the sole release coordinator. A trunk release selects one immutable source commit,
deploys it through Railway's connected-repository API, and verifies that public health reports its
full Git revision and canonical contract digest. Only then does it build an identically marked web
artifact, upload one immutable Cloudflare version, recheck trunk head, and promote that exact version.

Releases are serialized without cancelling an active deployment. A server failure stops before web
work. A web failure or superseded release leaves the prior Cloudflare version active; the newly
successful server remains temporarily compatible under the documented add/use/remove rollout. No
cross-provider rollback transaction exists. Provider source-triggered deployments are disabled.
[The production runbook](docs/operations/production-releases.md) owns configuration, executable
procedures, diagnostics, and recovery.

## 4. Browser-to-server authentication boundary

Browser login begins with a browser-held private verifier. WhatsApp approval, verified email, or
support recovery may approve the pairing for the same stable User, but none can establish a session
without that verifier. One approved pairing bootstraps one stable-User web session. The server owns
proof verification and session authority; the web owns keeping browser-private material out of URLs,
public references, and unrelated application state.

The web consumes only canonical API paths. The API process never serves browser routes or application
shell fallbacks, and the static host never exposes canonical API, OpenAPI, or authentication
implementations.

## 5. Cross-application acceptance

The PostgreSQL-backed browser acceptance runs the production web mode and checked-in Cloudflare
header policy on a dedicated HTTPS origin, with the real API on a second HTTPS origin. It probes shell
fallbacks, hashed assets, cache and security headers, OpenAPI/canonical/web-auth ownership, then
executes pairing, one-time redemption, session retention and revocation, and real Categories and
Transactions presentation. The loopback-only acceptance control may arrange database state but does
not replace those public HTTP paths.

Application-local test seams belong to the owning application architecture. This root seam proves the
contract between independently built and deployed applications.
