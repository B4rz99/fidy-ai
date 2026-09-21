# Architecture

---

## 1. System shape

The repository root is a private Bun workspace. It owns the lockfile, CI, compiler policy, quality
policy, and stable orchestration commands. Root commands delegate application work to the owning
workspace package.

The workspace contains two application packages:

- [`@fidy/server`](apps/server/ARCHITECTURE.md) owns the domain model, canonical operation
  declarations, schemas, and provider-neutral shell contracts. It is not a process runtime.
- [`@fidy/web`](apps/web/ARCHITECTURE.md) owns the React/Vite browser application and the static
  Cloudflare artifact.

Cloudflare is the production authority. The intended runtime adapters use Worker entrypoints with D1,
Durable Objects, Queues, Workflows, R2, Workers AI, and Email Workers as appropriate. Until an adapter
is present, its published server seam is unavailable rather than backed by a local process, an
in-memory substitute, or a removed infrastructure authority.

## 2. Cross-application contract

The server declares the canonical operation surface and owns its OpenAPI and complete reflected
operation-policy artifacts under `apps/server/contracts/`. Those artifacts are deterministic review
evidence, never another declaration. The web application derives its typed client from the
server-owned declaration and never owns a copied contract or imports server implementations.

The root TypeScript project-reference build expresses the server-before-web declaration dependency.
The mandatory root gate checks artifact freshness and compares the server-owned artifacts with the
pull-request base. A policy break requires an acknowledgement bound to the exact base digest,
candidate digest, finding set, and coordinated rollout issue. See
[Contract compatibility](docs/contract-compatibility.md).

Every stable-User domain API and agent surface derives from the server's canonical operation
definition. A proof-bearing credential-bootstrap API with no stable User is the narrow exception and
joins canonical authority only after proof exchange establishes a stable User.

## 3. Production topology

Cloudflare serves the immutable web artifact at `fidyapp.com`. The artifact is static-only: it
contains the browser shell, hashed assets, headers, and deployment metadata, and never contains
server source, source maps, or secrets. The checked-in Wrangler configuration is the sole web
runtime configuration.

GitHub Actions is the release coordinator. A trunk release checks out one exact source revision,
builds and validates one artifact, uploads one immutable Cloudflare version, rechecks the current
trunk revision, and promotes only that uploaded version. If trunk advances before promotion, the
release fails closed and leaves the prior version active. Provider-controlled source deployments are
not used.

The server package does not start a local production listener. Cloudflare API, storage, asynchronous
execution, email-ingress, and hosted-inference adapters are separate seams; an unimplemented seam
returns its typed unavailable result. No deployment step may reintroduce a process-local database,
queue, lock, workflow, or hosted-model fallback.

## 4. Browser-to-server authentication boundary

Browser login begins with a browser-held private verifier. WhatsApp approval, verified email, or
support recovery may approve a pairing for the same stable User, but none can establish a session
without that verifier. One approved pairing bootstraps one stable-User web session. The server-owned
contract defines proof verification and session authority; the web owns keeping browser-private
material out of URLs, public references, and unrelated application state.

The web consumes only canonical API paths. The static Cloudflare host never exposes server source,
OpenAPI implementation, or an unowned API fallback. Browser tests use explicit HTTP fixtures at the
adapter boundary and do not imply that a removed local server is a production authority.

## 5. Cross-application acceptance

The browser acceptance builds the production web mode and checks the checked-in Cloudflare header
policy on a loopback HTTPS origin. It probes shell fallbacks, hashed assets, cache and security
headers, and browser proof-handling behavior. API responses are explicit test fixtures; they do not
stand in for the future Worker/D1/DO/Queue/Workflow/R2/Workers AI integration gates.

Application-local test seams belong to the owning application architecture. Portable core, schema,
security, contract, browser, provider-boundary, and isolation evidence remains authoritative. Tests
whose only owner was a removed process runtime are deleted rather than replaced with local fakes.
