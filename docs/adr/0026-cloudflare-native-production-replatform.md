# Cloudflare-native production replatform

- **Status:** Accepted
- **Date:** 2026-09-21
- **Storage direction:** Superseded by [ADR 0041](0041-per-user-durable-object-storage-direction.md)
  for application storage and execution. [ADR 0038](0038-openai-hosted-inference.md) owns the
  hosted inference provider decision.
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
runtime owners, local queues and locks, cluster/durable-execution implementations, and inbound provider-webhook
authority. Missing adapters fail closed.

The target production shape is:

- an assets-only web Worker at `app.fidyapp.com`, with `fidyapp.com` redirecting to it;
- a public ingress Worker at `api.fidyapp.com` and private Core Worker connected by a service
  binding, with the latter owning canonical execution;
- per-User SQLite Durable Objects for User state and execution, with separate shared owners;
- retained owner work, native alarms and Cloudflare Queues for durable delivery;
- Cloudflare Workflows for durable multi-step execution, waits, retries, and provider ambiguity;
- private R2 buckets for statements, retained email material, and other bounded objects;
- Cloudflare Email Routing and an Email Worker for forwarded-email admission;
- Cloudflare-native metadata-only logs, traces, metrics, and alerts;
- Cloudflare WAF, DDoS protection, and operation-aware rate limits.

Workers are the default runtime. Worker-compatible Web APIs, streaming, bounded chunks, and WASM are
preferred for document processing. A stateless Container is permitted only after a measured parser
constraint proves it necessary; it never owns authoritative state.

Effect remains the application programming model. Worker, D1, Durable Object, Queue, Workflow, R2,
Email, Workers AI, and observability integrations are explicit shell adapters rather than portability
abstractions.

### Isolation and state

Public Ingress cannot access private User storage. Every User-owned operation carries an explicit
authenticated `UserId`; the private data API exposes no generic unscoped personal-data query;
background work carries its subject explicitly; and public and asynchronous seams require negative
cross-User evidence.

A successful canonical mutation and its required outbox record commit atomically. Queues and Workflows
are execution mechanisms, never domain authority. Consumers are idempotent, assume redelivery, retain
bounded identities rather than broad payloads, and reconcile ambiguous provider outcomes instead of
blindly retrying them. Immediate canonical reads agree with successful mutations; a derived projection required by a canonical read must meet that read's consistency contract.

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
- A provider-controlled inbound email webhook would make admission and retention depend on the wrong
  authority.
- Permanent staging, remote previews, and generic multi-cloud abstractions are deferred until a
  measured need justifies their cost.

## Deployment patch decisions and retained D1 evidence

An immutable uploaded Worker version receipt can be retained only while that version still
exists. The live deployment is checked independently because a recorded upload can have no
traffic. Forward placement in version uploads. Ordinary script-level metadata continues to
take effect through full deployment. Deferred deletion retains the prior tracked generation
through release verification. Cleanup-only execution has no deployment authority.

D1 migration execution disables retries because a failed response can follow a committed
change. Metadata calls outside that executor keep their existing retry policies. When the
Cloudflare HTTP fallback class lacks provider data, retain only a numeric native error code
so refusal classification can use it without retaining provider payloads.

Closed installed-release verification uses a private synthetic provider for the installation's
lifetime. The protected runner and Ingress sign separate exact request boundaries. Core forwards
the bytes whose digest it authenticated. The runner owns its signing key and renews the short
background-work window. The closed topology has no path to live product providers; configured
human Access still uses its real issuer.

Resource admission uses installed policy and decision time. Attempt pressure can be spent
despite later work refusal. The work reservation, required owner transition and explicit
completion assertion commit atomically. Outstanding capacity releases with the matching
completion. D1 settlement keeps ownership through interruption. Anonymous and shared scope
usage stays subject-free. Hosted usage retains original UTC day accounting even after Turns
expire. A malformed counter cannot become a lower observed consumption.

Platform canaries require evidence from the real Queue consumer and a completed native Workflow
step. Publication, handoff or a 2xx alone cannot pass readiness. The protected smoke runner
compares the observed release identity to the exact upload receipt. Smoke verifies fixed
synthetic bindings and carries no User, provider or ordinary ingress authority. Bound and
observe sampled owner work independently from platform Queue depth; missing measurements
never become healthy zeroes.

The Cloudflare adapter shard estimates seed longest-first packing from the recorded native
Linux run at revision `3d21108`. The assignment still includes every discovered file once.
[Seed timing run](https://github.com/B4rz99/fidy-ai/actions/runs/44432264215).

### Deployment evidence and recovery

Protect immutable candidate identities across plan, upload and observed traffic. An Alchemy
state read can describe a replacement's new generation while the old one remains pending
garbage collection. Verify actual provider metadata independently. Site assets and Worker
provider coordinates come from the installed artifact or provider when the plan does not
enumerate them. An unavailable or incomplete provider inventory cannot prove absence or
readiness. A partially applied policy update rereads the ordered incumbent and patches
only the next reviewed rule.

Keep version upload, Access reattachment and traffic promotion separate. Preserve the
original sealed-stage and deployment evidence for an interrupted upload or rollback.
Resume only the same proved serving or dormant pair. Never substitute positive traffic
for a denied zero-traffic upload. Script-level privacy settings are independently verified.
An interrupted write or stale provider read cannot prove rollback. Rollback eligibility
compares exact source and versioned bindings, including Durable Object configuration.

Closed installation enrollment creates synthetic identities once. Login-only recovery can
resume a recorded subject without signup or a new observation window. User and synthetic
provider results are materialized in their deterministic subject order. Preserve pre-enrollment,
cleanup and physical census evidence independently of the foreground report. A digest for
the narrowly reviewed Workers types refresh binds the three exact before/after manifests.
