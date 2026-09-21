# Cloudflare-native production replatform

- **Status:** Accepted
- **Date:** 2026-09-21
- **Supersedes:** ADR 0018's Railway/Cloudflare production topology, ADR 0007's PostgreSQL RLS mechanism, ADR 0024's PostgreSQL/Cluster execution substrate, and ADR 0025's PostgreSQL admission substrate. Their domain, isolation, durability, provider-ambiguity, and safe-rollout invariants remain requirements unless this decision explicitly replaces the mechanism.

## Context

Fidy is unreleased, its development data and PostgreSQL migration history are disposable, and its Railway deployment is not operational. Preserving Bun, Railway, PostgreSQL, or technical compatibility would carry infrastructure-specific complexity into a new platform without protecting Users. The goal is instead to run all Fidy-owned production compute, state, storage, asynchronous execution, edge security, and observability on Cloudflare, managed Alchemy-first, while retaining Effect and the runtime-independent domain model.

Cloudflare cannot replace specialist business providers. Kapso and Meta remain the WhatsApp boundary, Wompi remains the billing provider, Resend remains outbound email delivery, and GitHub remains the source and CI coordinator. Fidy accepts foreign processing under the required Colombian contracts, disclosures, authorization, security controls, accountability, rights handling, and documented provider review.

## Decision

Rebuild every currently implemented capability as a Cloudflare-native system. Planned but unimplemented capabilities remain future work. Remove Railway, Bun production runtime, PostgreSQL, the active PostgreSQL migration chain, Sentry, direct OpenAI inference, and the Resend/Svix inbound-email path. Preserve correct core decisions, canonical operation declarations, Schemas, contracts, and tests when they are genuinely runtime-independent.

The target production shape is:

- static web assets at `app.fidyapp.com`;
- a public ingress Worker at `api.fidyapp.com` with no D1 binding;
- a private Core Worker, reachable through a service binding, that owns canonical execution and the private data API;
- D1 as the one authoritative relational store;
- one per-User Durable Object for serialized coordination, never as a second financial ledger;
- a D1 transactional outbox and Cloudflare Queues for at-least-once work delivery;
- Cloudflare Workflows for durable multi-step execution, waits, retries, and external-provider ambiguity handling;
- private R2 buckets for statements, retained email material, and other large objects;
- Cloudflare Email Routing and an Email Worker for forwarded-email Ingestion;
- direct Workers AI bindings for Fidy-controlled hosted-agent inference, with the selected model configurable;
- Cloudflare-native logs, traces, metrics, and alerts through closed metadata-only projections;
- Cloudflare WAF, DDoS protection, and operation-aware rate limits, with Turnstile limited to suitable human browser flows;
- `fidyapp.com` redirecting to `app.fidyapp.com` until it owns a public site.

Workers are the default runtime. Worker-compatible Web APIs, streaming, bounded chunks, or WASM are preferred for document processing. A stateless Cloudflare Container is permitted only after a real test proves that a bounded parser cannot fit Workers' runtime constraints; it never owns authoritative state.

Effect remains the application programming model. The layer-major core/shell boundary and canonical-operation derivation remain. Cloudflare Worker, D1, Durable Object, Queue, Workflow, R2, Email, Workers AI, and observability integrations are explicit shell adapters rather than portability abstractions.

### Isolation and state

D1 has no PostgreSQL-equivalent row-level security. The replacement is a mandatory private application boundary: the public Worker cannot access D1; every User-owned operation carries an explicit authenticated `UserId`; the private data API exposes no generic unscoped personal-data query; background work carries the subject explicitly; and two-User negative tests cover every public and asynchronous seam. General administrative browsing of all Users' financial records is not provided. Global state is limited to narrow identity, provider-callback, scheduling, billing, support, and metadata-only operational indexes.

A successful canonical mutation and its required outbox record commit atomically. Queues and Workflows are execution mechanisms, never domain authority. Consumers are idempotent, assume redelivery, retain bounded identities rather than broad payloads, and reconcile ambiguous provider outcomes instead of blindly retrying them. Immediate canonical reads agree with successful mutations; explicitly derived dashboards and operational projections may lag briefly. D1 read replication is disabled initially.

Create a fresh Cloudflare-native migration baseline. Before the first real User, the production database may be deliberately reset. Afterward, applied migrations are immutable and forward-only; releases use additive expand-and-contract changes, and destructive cleanup requires explicit approval. Money remains exact, User context remains explicit, append-only evidence remains append-only, and existing retention and provider-authenticity invariants remain in force.

### External providers

Kapso, Meta, Wompi, and Resend are narrow external provider adapters controlled through Cloudflare ingress and egress boundaries. Resend is outbound-only. Fidy-controlled inference uses Workers AI without external-model fallback; AI Gateway is omitted until it solves a demonstrated governance need, and prompt/response logging is disabled by default.

Kapso-generated voice transcripts are an explicit exception to the Workers AI policy because they are part of the accepted WhatsApp provider service. Production use requires verified Kapso contracts and subprocessors, the shortest workable retention, disabled unused AI/agent/workflow features, tested deletion or a documented executable deletion process, and accurate foreign-processing disclosure. Default indefinite provider retention is a launch blocker.

### Provisioning and releases

Alchemy is the normal infrastructure and deployment entry point. A checked-in Cloudflare API or Wrangler command is allowed when Alchemy lacks a required safe primitive; manual dashboard state is not a normal deployment mechanism. Secrets use Cloudflare secret bindings or Secrets Store and never enter source, Alchemy state, logs, generated non-secret configuration, or ordinary command output.

GitHub Actions deploys each passing merge to `trunk`. Production is the only persistent remote environment; PR CI uses local Cloudflare emulation and deterministic provider fakes. No staging, preview, separate test account, or ephemeral remote stack is maintained. Before admitting the first real User, the empty production stack is the remote proving ground: synthetic checks may exercise and reset it, after which onboarding is enabled.

A release uploads immutable Worker candidates with zero normal traffic, invokes the exact versions through Cloudflare version overrides, and runs bounded smoke checks for release identity, configuration, service bindings, D1 schema visibility, R2, a reserved Durable Object, no-op Queue/Workflow wiring, routing, authorization rejection, and safe telemetry. Smoke work is idempotent, contains no personal data, and causes no Kapso, Wompi, Resend, or meaningful model effect. Passing candidates are promoted; failing candidates leave the stable versions serving traffic. A checked-in Wrangler/API escape hatch may perform version promotion and code-only rollback because Alchemy does not provide a general full-stack rollback. Stateful resources and external effects are never represented as rolled back.

## Consequences

This is a replatform, not a lift-and-shift. PostgreSQL roles, RLS, locks, Effect SQL persistence, and Bun/native adapters cannot be mechanically translated; each protected invariant needs Cloudflare-backed evidence before its old mechanism is deleted. D1 semantics, bundle and memory limits, Durable Object coordination, Queue redelivery, Workflow versioning, Worker version promotion, Alchemy lifecycle behavior, and any parser Container escape hatch require focused proofs on the pinned versions.

Cloudflare becomes one large runtime failure domain, and no cross-provider disaster-recovery system is introduced for launch. The accepted simplicity cost is also that remote platform behavior is first exercised against the empty production stack before launch and by bounded production smoke checks afterward. A paid Cloudflare plan is acceptable; correctness, security, Colombian compliance, and one-developer operability take precedence over free-tier constraints, portability, and speculative scale.

## Rejected alternatives

- Retaining Railway, PostgreSQL, or Hyperdrive would violate the Cloudflare-owned runtime and state goal.
- D1-only execution would weaken per-User serialization and external-effect ordering.
- Durable-Object-only authority would multiply databases and complicate identity indexes, callbacks, migrations, export, and operations.
- Containers as the default runtime would preserve the old server shape and add lifecycle complexity without replacing relational authority.
- Full blue-green infrastructure would duplicate state without a safe cross-environment synchronization model; zero-traffic immutable Worker candidates provide the required code-release gate instead.
- Cloudflare-only business providers are impossible because WhatsApp and Colombian billing remain external services.
- Generic multi-cloud abstractions, permanent staging, remote preview stacks, and cross-provider disaster recovery are deferred until a measured need justifies their cost.
