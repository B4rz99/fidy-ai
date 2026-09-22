# Server architecture

Read the repository [`ARCHITECTURE.md`](../../ARCHITECTURE.md) first. This document owns the stable
boundaries of `@fidy/server`; it does not describe a process deployment because this package has no
production listener.

## 1. Application shape

`apps/server` is the canonical contract and domain package for the Cloudflare application:

- `core/` contains pure business decisions and schemas. Core code has no platform requirements.
- `shell/` contains operation declarations, provider-boundary contracts, policy projection, and
  portable adapter code. It must not manufacture a local runtime authority.
- `contracts/` contains generated OpenAPI and operation-policy evidence owned by the canonical API.
- `src/client.ts` is the browser-safe declaration seam. It exports no server implementation.

The deleted process entrypoint, SQL persistence, in-process queue/lock/workflow machinery, and
provider-specific hosted inference implementations are not compatibility surfaces. Railway,
PostgreSQL, and a Bun process are superseded Production architecture under ADR 0026. The private
Core Worker in `infra/cloudflare` currently proves the service-binding boundary and bounded health
projection; later Cloudflare adapters will compose this package's published contracts with D1,
Durable Objects, Queues, Workflows, R2, Workers AI, or Email Workers. Until then, unavailable
operations fail closed.

## 2. Slices and ownership

A slice owns its domain decisions and published schemas. Cross-slice references use stable ids and
published interfaces; implementation files and `internal/` modules remain private. Core does not
import shell or platform code. Shell adapters load external values, pass plain values to core, and
map typed domain failures to the public contract.

The canonical operation definition is the source for reflected operation ids, access metadata,
suggested operations, OpenAPI, MCP definitions, and hosted-agent tool descriptions. The reflected
registries remain complete even when their execution implementation is unavailable; a registry entry
must never silently fall back to local state.

## 3. Security and subject boundaries

`UserId` is explicit wherever a decision needs a subject. No ambient process-local current-user
service, claim id, provider id, or opaque identifier grants authorization. Browser login keeps the
private verifier in the browser and treats the server/Worker as the proof-verification authority.

Cloudflare storage adapters must preserve the same subject boundary: D1 queries receive an explicit
subject, Durable Object keys are coordination identities rather than authorization, and Queue or
Workflow payloads contain only bounded, secret-free projections. Email Worker admission and R2
content retrieval are external to this package's inbound forwarding seam. The application accepts
only the provider-neutral forwarded-email contract and remains fail closed without an adapter.

Telemetry is metadata-only and provider-neutral. Secrets, request bodies, model content, provider
responses, and personal data do not cross the telemetry contract.

## 4. External providers

`shell/outbound-http` is the only raw outbound provider transport boundary. It publishes closed
requests for the retained specialist providers—Kapso/Meta, Wompi, and outbound Resend—and owns fixed
destinations, credential handling, redirects, byte limits, status projection, and safe failures.
Provider adapters cannot import raw transport or private implementation modules.

Hosted inference exposes a provider-neutral contract and a typed unavailable result until the
Workers AI adapter is implemented. There is no external-model fallback. Provider-controlled inbound
webhook authority is removed; Cloudflare Email Workers own admission and handoff instead.

## 5. Persistence and asynchronous execution

This package contains schemas and operation contracts, not a process-local database, SQL transaction,
queue, lock, workflow, or migration authority. The Cloudflare implementation will make D1 the
application state authority, Durable Objects the keyed coordination authority, Queues the redelivery
mechanism, Workflows the durable multi-step mechanism, and R2 the bounded content authority. Those
platform services must remain infrastructure, not alternate domain models.

Atomic domain mutation and outbox behavior belong in the future D1/Worker adapter. If that adapter is
absent, canonical mutation execution returns the closed unavailable failure. It must not use an
in-memory map, local queue, process lock, or best-effort continuation as a substitute.

## 6. Testing seams

Use the smallest seam that proves the behavior:

- core tests call pure decisions and schemas directly;
- contract tests validate canonical ids, reflected policy, OpenAPI, and compatibility artifacts;
- security tests cover proof handling, redaction, bounded input, provider authentication, and
  subject isolation;
- provider-boundary tests use the published outbound transport seam;
- browser tests exercise the built static shell with explicit HTTP fixtures;
- Cloudflare adapter tests, when an adapter exists, must exercise D1/DO/Queue/Workflow/R2/Workers AI
  behavior through platform seams rather than recreating the removed local runtime.

Tests whose only owner was a removed runtime or provider implementation are deleted. Portable
domain, schema, security, contract, browser, provider-boundary, and isolation evidence remains
authoritative.
