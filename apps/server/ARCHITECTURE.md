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
- `cloudflare/` contains the Worker entrypoints, platform adapters, D1 migrations, and their tests;
  it implements the server-owned contracts without changing the portable core or shell.
- `src/client.ts` is the browser-safe declaration seam. It exports no server implementation.

The deleted process entrypoint, SQL persistence, in-process queue/lock/workflow machinery, and
provider-specific hosted inference implementations are not compatibility surfaces. Railway,
PostgreSQL, and a Bun process are superseded Production architecture under ADR 0026. The private
Core Worker in `apps/server/cloudflare` owns the D1-backed Categories adapter path, the direct
Workers AI binding boundary, the service-binding boundary, and the bounded health projection. It
declares that binding without building it: the User coordinator Durable Object builds the
hosted-inference layer, and only for the Memory work that consumes it. The server's Cloudflare
runtime owns the reusable resource-admission foundation that later Core adapters install with their
policies. Those adapters will compose this package's published contracts with
Durable Objects, Queues, Workflows, R2, or Email Workers. Operations without an adapter fail closed.

## 2. Slices and ownership

A slice owns its domain decisions and published schemas. Cross-slice references use stable ids and
published interfaces; implementation files and `internal/` modules remain private. Core does not
import shell or platform code. Shell adapters load external values, pass plain values to core, and
map typed domain failures to the public contract.

The canonical operation definition is the source for reflected operation ids, access metadata,
suggested operations, OpenAPI, MCP definitions, and hosted-agent tool descriptions. The reflected
registries remain complete even when their execution implementation is unavailable; a registry entry
must never silently fall back to local state. The direct proof-bearing PATPairing API has no stable
User or canonical operation policy; its generated OpenAPI is checked for freshness and breaking
changes independently of the stable-User contract pair. Breaking direct-client changes require a
nonbreaking add/use/remove rollout, not a canonical operation-policy acknowledgement.

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

Hosted inference exposes a provider-neutral contract backed only by the direct Workers AI binding
the User coordinator Durable Object builds for Memory work, which the Core Worker declares without
building. A closed approved-model schema and live provider-conformance gate protect canonical tool,
continuation, structured-output, and `es-CO` behavior. Unsupported or absent configuration fails
with typed unavailability, and there is no gateway, direct OpenAI, or external-model fallback.

## 5. Persistence and asynchronous execution

This package contains schemas and operation contracts, not a process-local database, SQL transaction,
queue, lock, workflow, or migration authority. The Cloudflare implementation will make D1 the
application state authority, Durable Objects the keyed coordination authority, Queues the redelivery
mechanism, Workflows the durable multi-step mechanism, and R2 the bounded content authority. Those
platform services must remain infrastructure, not alternate domain models.

The D1 baseline contains the stable Category taxonomy, User-owned keyword rules, and the
Cloudflare resource-admission tables. The canonical Categories implementation runs the bounded
ordered query, decodes every row through the published Category schema, and is shared by the
operation registry and the private Core Worker adapter. Keyword rules are scoped to one User and
reference stable CategoryIds; capture reads them for future Transactions and no rule change
rewrites retained history.
The infrastructure admission primitive atomically charges Stable-User, source, operation,
outstanding-work, and spend policies with caller-owned proof, replay, or outbox statements. Its
resource refusal and authority-unavailable failures are separate from commercial allowance results.
The shared canonical mutation unit in `cloudflare/mutations` composes the Reconciliation, Category
keyword-rule, and Memory owners into one User-scoped D1 commit, derived from the operation catalog
so a new canonical mutation joins it without editing the unit. Domain-specific outbox adapters
remain later work. If an adapter is absent, canonical mutation execution returns the closed
unavailable failure. It must not use an in-memory map, local queue, process lock, or best-effort
continuation as a substitute.

Statement bytes enter private R2 through a bounded, User-authenticated browser-session transport,
not a canonical operation or PAT surface. Staging returns no readable content or authority. Only
`ingestion.submitForExtraction`, whose input is a retry key and an opaque staged reference rather
than bytes, can publish after checking ownership, size, and digest. R2 and D1 cannot commit together:
the Core Worker owns the R2 binding and expiry sweep, and no authoritative submission may refer to
missing or mismatched bytes. Unpublished material expires; published bytes follow the submission's
retention while their staging row records their eventual removal. See
[ADR 0028](../../docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md) for the
staging and publication protocol.

Individual and atomic-batch statement submissions share one User-scoped publication unit: the
submission, staging promotion, Free-backfill reservation, credential accountability, metadata-only
success AuditLogEntry, and bounded extraction outbox identity commit together or not at all. A batch
admits at most one statement child; its refusal follows the same canonical contract as individual
submission. See [ADR 0029](../../docs/adr/0029-atomic-batch-accountability-boundaries.md) for
accountability and abort attribution.

## 6. Testing seams

Use the smallest seam that proves the behavior:

- core tests call pure decisions and schemas directly;
- contract tests validate canonical ids, reflected policy, OpenAPI, and compatibility artifacts;
- security tests cover proof handling, redaction, bounded input, provider authentication, and
  subject isolation;
- provider-boundary tests use the published outbound transport seam;
- browser tests exercise the built static shell with explicit HTTP fixtures;
- Cloudflare adapter tests exercise Categories through public ingress, the real service binding, and
  local D1; resource-admission tests exercise atomic D1 batches through independent adapters and
  persisted runtime restarts; statement staging and acceptance exercise local D1 and R2 directly to
  prove actual bytes, digests, ownership, interruption, replay, admission bounds, and bounded
  retention, including publication and retention through the private Core Worker; the release gate
  exercises Workers AI through its real binding; later DO/Queue/Workflow tests use those platform
  seams rather than recreating the removed local runtime.

Tests whose only owner was a removed runtime or provider implementation are deleted. Portable
domain, schema, security, contract, browser, provider-boundary, and isolation evidence remains
authoritative.
