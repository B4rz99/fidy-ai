# Cloudflare-native production replatform

- **Status:** Accepted
- **Date:** 2026-09-21
- **Supersedes:** Earlier process-runtime, relational-database, cluster, and provider-specific
  deployment decisions. Their domain, isolation, durability, provider-ambiguity, and safe-rollout
  invariants remain requirements unless this decision explicitly replaces the mechanism.

## Context

Fidy is unreleased. Its production authority must not depend on a local process, a mutable host, or a
removed provider-specific runtime. Cloudflare is the target for Fidy-owned compute, state, storage,
asynchronous execution, edge security, email admission, observability, and hosted inference, while
Effect and the runtime-independent domain model remain.

Cloudflare cannot replace specialist business providers. Kapso and Meta remain the WhatsApp boundary,
Wompi remains the billing provider, Resend remains outbound email delivery, and GitHub remains the
source and CI coordinator. Inbound email is a Cloudflare Email Worker boundary, not an outbound email
provider webhook.

## Decision

Use Cloudflare-native adapters for every production-owned capability. Planned but unimplemented
capabilities remain future work. Preserve canonical operation identifiers, schemas, contract artifacts,
domain decisions, security invariants, and portable evidence. Remove process listeners, relational
runtime owners, local queues and locks, cluster/durable-execution implementations, direct external
model adapters, and inbound provider-webhook authority. Missing adapters fail closed.

The target production shape is:

- an assets-only web Worker at `app.fidyapp.com`, with `fidyapp.com` redirecting to it;
- a public ingress Worker at `api.fidyapp.com` and private Core Worker connected by a service
  binding, with the latter owning canonical execution;
- D1 as the authoritative relational store;
- one per-User Durable Object for serialized coordination, never as a financial ledger;
- a D1 transactional outbox and Cloudflare Queues for at-least-once work delivery;
- Cloudflare Workflows for durable multi-step execution, waits, retries, and provider ambiguity;
- private R2 buckets for statements, retained email material, and other bounded objects;
- Cloudflare Email Routing and an Email Worker for forwarded-email admission;
- direct Workers AI bindings for hosted-agent inference, without external-model fallback;
- Cloudflare-native metadata-only logs, traces, metrics, and alerts;
- Cloudflare WAF, DDoS protection, and operation-aware rate limits.

Workers are the default runtime. Worker-compatible Web APIs, streaming, bounded chunks, and WASM are
preferred for document processing. A stateless Container is permitted only after a measured parser
constraint proves it necessary; it never owns authoritative state.

Effect remains the application programming model. Worker, D1, Durable Object, Queue, Workflow, R2,
Email, Workers AI, and observability integrations are explicit shell adapters rather than portability
abstractions.

### Isolation and state

The public Worker cannot access private D1 directly. Every User-owned operation carries an explicit
authenticated `UserId`; the private data API exposes no generic unscoped personal-data query;
background work carries its subject explicitly; and public and asynchronous seams require negative
cross-User evidence.

A successful canonical mutation and its required outbox record commit atomically. Queues and Workflows
are execution mechanisms, never domain authority. Consumers are idempotent, assume redelivery, retain
bounded identities rather than broad payloads, and reconcile ambiguous provider outcomes instead of
blindly retrying them. Immediate canonical reads agree with successful mutations; derived projections
may lag briefly.

Create a fresh Cloudflare migration baseline before the first real User. After launch, applied
migrations are immutable and forward-only; destructive cleanup requires explicit approval. Money
remains exact, User context remains explicit, append-only evidence remains append-only, and retention
and provider-authenticity invariants remain in force.

### Releases

Alchemy is the sole Production topology authority. GitHub Actions checks out one exact trunk
revision, builds and validates its static artifact, plans the complete stack, rechecks trunk
immediately before deployment, and deploys only while the candidate remains current. A superseded
candidate leaves the prior topology active. Secrets use Cloudflare secret bindings and never enter
source, generated browser output, logs, or command arguments.

## Consequences

Every removed invariant owner needs Cloudflare-backed evidence before its replacement is enabled.
D1 semantics, Durable Object coordination, Queue redelivery, Workflow versioning, Worker version
promotion, R2 bounds, Email Worker admission, and Workers AI limits require focused adapter tests.
Until those tests and adapters exist, the corresponding contract returns a typed unavailable result.

Cloudflare is one runtime failure domain at launch. Correctness, security, Colombian compliance, and
operability take precedence over portability, speculative scale, and compatibility with removed
infrastructure.

## Rejected alternatives

- A local process, mutable host, or hidden in-memory fallback would make correctness depend on one
  runtime instance.
- D1-only execution would weaken per-User serialization and external-effect ordering.
- Durable-Object-only authority would multiply data stores and make export and identity indexes harder.
- A direct external-model fallback would bypass the Workers AI governance boundary.
- A provider-controlled inbound email webhook would make admission and retention depend on the wrong
  authority.
- Permanent staging, remote previews, and generic multi-cloud abstractions are deferred until a
  measured need justifies their cost.
