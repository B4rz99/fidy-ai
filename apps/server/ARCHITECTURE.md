# Server architecture

This document owns the stable internal architecture of `@fidy/server`. Read the repository
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) first for system shape, cross-application contracts,
production topology, and browser-to-server ownership.

This is an orientation map of server boundaries, ownership, and durable invariants. It does not
repeat domain definitions, ADR rationale, operational procedures, migration inventories, or
implementation-level configuration. Those belong in `CONTEXT.md`, the relevant
[ADRs](../../docs/adr/), [security and coding standards](../../SECURITY_STANDARDS.md),
the [durable-execution inventory](../../docs/architecture/durable-execution-inventory.md), and
[operational runbooks](../../docs/operations/).

## 1. Application shape

`apps/server` is the `@fidy/server` application package. Its source tree is layer-major:

- `core/` contains pure business decisions typed `Effect<A, E, never>` and touches no external
  service.
- `shell/` contains repositories, handlers, API assembly, adapters, and all other effects.
- `src/main.ts` is the only production entrypoint. Scripts compose shell layers and contain no
  domain decisions.

The API assembly imports slice operation definitions. Handlers use the assembled API as required by
the HTTP builder, and `http.ts` composes the handler layers. This direction is acyclic and is
protected by the dependency graph. Server-specific build and deployment adapters remain with the
package; production topology and release procedures remain in the repository-level architecture and
runbook.

## 2. Slices and ownership

> **A slice owns data. A process coordinates slices.**

A process that touches one slice's data lives inside that slice. A process that owns data nobody
else owns is a slice; a process that owns no data is shell-only. A process never writes another
slice's tables. It calls the owning slice's operations so that invariants and atomicity remain in
one place. The nested WhatsApp operational slice follows the same rule for its delivery and ingress
state.

Use three checks when drawing a boundary:

1. Data that must commit atomically has one owner unless an accepted coordination decision composes
   owner-published operations.
2. Cross-slice references use stable ids, not embedded objects.
3. An invariant that must hold immediately is enforceable inside one slice.

A slice is not a bounded context or a use case. Fidy is one bounded context with one vocabulary;
API groups are presentation choices. See [ADR 0003](../../docs/adr/0003-layer-major-core-shell-and-slice-ownership.md)
and [ADR 0010](../../docs/adr/0010-whatsapp-channel-operational-slice.md).

### Core references

Core may import ownerless values from `core/_shared` or a sibling's narrow `reference.ts`. It may
not import a sibling's model, rules, errors, taxonomy, repository, or other implementation. Shell
loads data and passes plain values to core decisions.

## 3. The functional core

Core code returns `Effect<A, E, never>`. The `never` requirement is the compiler-visible purity
fence: requesting a service does not compile. Core takes time, generated ids, user context, and
already-loaded values as inputs. The shell supplies those values, performs I/O, and coordinates
processes around the decisions.

## 4. Canonical operations and agent surface

The canonical schema for a domain entity lives in `core/<slice>/model.ts`. The canonical operation
lives in `shell/<slice>/operations.ts`, where transport and access policy belong: path, status,
caller requirement, tier, cost class, hosted-agent confirmation policy, and query-or-mutation kind.
The operation references the core schema rather than maintaining a transport model.

The assembled `FidyApi` is the source for reflected operation ids, access metadata, suggested
operations, OpenAPI, MCP definitions, and the hosted-agent toolkit. The browser consumes one
server-owned declaration seam and never imports server implementations. Derived shapes and
relational projections are built from their source schemas; parallel operation maps and DTOs are
not maintained. See [ADR 0004](../../docs/adr/0004-canonical-operation-derivation.md).

A canonical query observes domain state without requesting a domain transition or external effect.
A canonical mutation requests a domain transition, records durable work, or causes an external
effect. Mutations are transaction-composable: individual and atomic-batch execution share the same
implementation, and the batch child union is derived from canonical mutations rather than a
feature-specific allowlist. See [ADR 0012](../../docs/adr/0012-canonical-mutations-are-transaction-composable.md).

Proof-bearing bootstrap APIs and browser-only payment-credential enrollment are deliberate narrow
exceptions when transient credentials must remain unrepresentable to canonical callers, hosted
agents, OpenAPI, logs, or persistence. They end at stable-User canonical authority and do not
create parallel domain contracts. The payment boundary requires exact Origin, a fresh WebSession,
current Consent, no-store responses, bounded JSON, User-stable provider admission, and browser-safe
outputs. It starts first collection with a browser-generated `PaymentRequestId`; provider responses
and redirects are observations, never settlement authority. See
[ADR 0015](../../docs/adr/0015-browser-paired-web-authentication.md) and
[ADR 0021](../../docs/adr/0021-browser-only-payment-credential-enrollment.md).

### Hosted agent

`AgentService` owns the hosted runtime and is its only public service boundary. Its closed
source-specific entrypoints lexically own session and Turn admission, context construction,
hosted inference, canonical execution, delivery, and terminalization. HostedInference,
WorkingContext, and ConversationContinuity remain private runtime concerns; executable lifecycle
capabilities do not cross that boundary. Hosted calls use the same canonical authorization and
confirmation policy as other callers. See [ADR 0014](../../docs/adr/0014-deep-hosted-turn-modules.md)
and [ADR 0019](../../docs/adr/0019-hosted-runtime-owns-conversation-continuity.md).

### Browser authentication and delegated authority

Browser login is a browser-held proof paired with an established User proof. Browser Login alone
creates the WebSession; email authentication, recovery, WhatsApp approval, and PAT lifecycle do not
create parallel Users or sessions. Identity, EmailAuthentication, Recovery, Consent, and PAT owners
publish operations for the shell to compose without transferring data ownership. Details belong in
[ADR 0015](../../docs/adr/0015-browser-paired-web-authentication.md),
[ADR 0016](../../docs/adr/0016-web-authorized-pat-issuance.md),
[ADR 0017](../../docs/adr/0017-atomic-pat-consent-lifecycle.md), and
[ADR 0020](../../docs/adr/0020-mandatory-verified-email-authentication-and-recovery.md).

## 5. User context and isolation

`UserId` is an explicit argument to every repository and core function that needs user context. The
caller is resolved at the adapter boundary and passed inward; there is no ambient `CurrentUser`
service. Ordinary aggregates do not carry an owner field because the User is the operation context.
`ConsentRecord` and `AuditLogEntry` carry an explicit subject because they attest who acted.

PostgreSQL RLS reinforces the same boundary. Every User-owned path activates transaction-local
User context before reading or writing data, and background work carries its `UserId` explicitly.
A claim, provider id, entity id, execution id, or opaque UUID is never authorization. No database
transaction spans model or provider work. See [ADR 0005](../../docs/adr/0005-explicit-user-context-and-isolation.md),
[ADR 0007](../../docs/adr/0007-postgresql-row-level-user-isolation.md), and
[SECURITY_STANDARDS.md](../../SECURITY_STANDARDS.md).

Authorization is derived from the canonical operation and is applied consistently to HTTP, hosted,
MCP, CLI, and suggested-operation surfaces. The operation-derived API seam proves User isolation;
non-request paths use the same explicit subject flow rather than a separate ownership mechanism.

## 6. Errors and external effects

Core exposes domain failures without HTTP vocabulary. Shell adapters map those failures to the
transport contract and keep each mapping exhaustive.

External providers stay at narrow shell boundaries. Shared outbound transport applies the repository's
bounds, credential, tracing, and telemetry policy; the provider adapter owns request encoding, status
interpretation, runtime decoding, retry certainty, and workflow-failure mapping. Raw provider
responses and bodies do not cross the boundary. Provider work never runs inside a PostgreSQL
transaction; ambiguous external outcomes are handled by the owning durable workflow or domain
state. See [CODING_STANDARDS.md](../../CODING_STANDARDS.md) and
[SECURITY_STANDARDS.md](../../SECURITY_STANDARDS.md).

## 7. Persistence and durable execution

Migrations form one globally ordered history in `shell/db/migrations/`. Relational rows are
projections of core models, not parallel domain models. Repositories may flatten values for storage
and queries, but reconstruct the canonical value on every read.

PostgreSQL owns User isolation and immediate invariants: constraints, atomic statements, short
transactions, and commit-time locks. Effect's SQL-backed `PersistedQueue`, `Workflow`, and Cluster
facilities own durable execution mechanics. Slices retain domain lifecycle, authorization and RLS,
provider idempotency or reconciliation, retention policy, and safe observability. Every durable
path that can reach User data carries an explicit `UserId` and only a bounded resume projection.

Distributed security and spend admission remains PostgreSQL-backed; process-local Effect limits
only own restart-safe resource bounds. Best-effort maintenance may delay cleanup but cannot authorize
expired work. Correctness-critical continuation uses durable execution. No Fidy queue, lease,
workflow, or runner framework should be layered over the Effect substrate.

Subscription atomically persists and publishes an immutable pending `BillingAttempt` before arming
a provider mutation once. An ambiguous armed mutation is never resent. Reconciliation uses retained
Wompi transaction identity because Wompi does not document merchant-reference lookup. Only bounded,
authoritative evidence matching the attempt may atomically create its paid period and activate paid
Pro.

See [ADR 0024](../../docs/adr/0024-effect-durable-execution.md),
[ADR 0025](../../docs/adr/0025-retain-postgresql-admission.md), and the
[durable-execution inventory](../../docs/architecture/durable-execution-inventory.md) for
substrate choices, per-flow mechanics, migration status, and retention details.

## 8. Testing seams

Use the smallest seam that proves the behaviour:

- **Core:** call exported pure decisions directly, without a server or database.
- **API:** traverse the assembled operations with real PostgreSQL to prove decoding, authorization,
  persistence, responses, derived suggestions, and User isolation.
- **Agent:** call `AgentService` through the CLI harness with language-model and terminal adapters
  substituted while canonical application paths remain real.
- **Asynchronous and public-channel:** exercise the exported worker step and signed provider ingress
  with real Consent, Identity, repositories, PostgreSQL, durable execution, and canonical paths;
  substitute only external provider and model behaviour.

Core tests do not mock shell collaborators. A stable pure policy may be tested directly, but its
integration remains covered at the API seam. Exact mutation, coverage, and acceptance gate settings
belong to the test configuration and [ADR 0006](../../docs/adr/0006-test-seams-and-core-mutation-gate.md).
