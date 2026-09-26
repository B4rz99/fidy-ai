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
hosted-inference layer only for Memory work and admitted hosted Turns that consume it. The server's
Cloudflare runtime owns resource admission, User-coordinated canonical mutations, statement staging,
and the Queue/Workflow adapters for onboarding email, browser-pairing email, email replacement, and
billing collection. Operations without an installed adapter fail closed; declaring an operation or
binding is not evidence that its full execution path is available.

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
the User coordinator Durable Object builds for Memory work and hosted Turns, which the Core Worker
only declares without building. A closed approved-model schema and live provider-conformance gate protect canonical tool,
continuation, structured-output, and `es-CO` behavior. Unsupported or absent configuration fails
with typed unavailability, and there is no gateway, direct OpenAI, or external-model fallback.

## 5. Persistence and asynchronous execution

This package contains schemas and operation contracts, not a process-local database, SQL transaction,
queue, lock, workflow, or migration authority. The Cloudflare implementation makes D1 the
application state authority, Durable Objects the keyed coordination authority, Queues the redelivery
mechanism, Workflows the durable multi-step mechanism, and R2 the bounded content authority. Those
platform services must remain infrastructure, not alternate domain models.

The D1 baseline contains domain state, authentication and accountability evidence, durable outboxes,
statement staging/publication state, and resource-admission tables, alongside the stable Category
taxonomy and User-owned keyword rules. Subscription queries derive AccessTier from the original
TrialPeriod and settled paid period at the decision instant, return a bounded User-owned standing
projection and published Prices, and audit each protected read in its D1 unit. Verified Wompi
settlement creates immutable paid periods in the same atomic unit as BillingAttempt success; no
independent AccessTier owner is stored. Hosted Turns are serialized by the per-User coordinator;
D1 retains their User entry and Pending status atomically. A generated reply is an immutable
short-lived delivery proposal, not Transcript evidence. The authenticated browser receives the
proposal, renders it, and sends a one-use receipt through the same coordinator. Only that receipt
atomically writes the exact assistant entry and Completed status; delivery failure becomes Failed,
while an unacknowledged proposal becomes Interrupted after its delivery window via a per-User
Durable Object alarm, even without another request. The private Core scheduled sweep independently
recovers missing alarms, including admission-to-alarm failures, without a User request. Expired
receipts fail closed and recover the
pending Turn. The same per-User alarm removes exact terminal Transcript content after thirty days
while retaining metadata-only Turn status; D1 rejects premature or Pending-evidence deletion.
The browser conversation/receipt contract is server-owned and deliberately separate
from canonical tool-callable operations (see root architecture §2). The User's daily
hosted-Turn allowance is read before model preflight and guarded again at insertion. The canonical Categories implementation runs the bounded
ordered query, decodes every row through the published Category schema, and is shared by the
operation registry and the private Core Worker adapter. Keyword rules are scoped to one User and
reference stable CategoryIds; capture reads them for future Transactions and no rule change
rewrites retained history.
The infrastructure admission primitive atomically charges Stable-User, source, operation,
outstanding-work, and spend policies with caller-owned proof, replay, or outbox statements. Its
resource refusal and authority-unavailable failures are separate from commercial allowance results.
The shared canonical mutation unit in `cloudflare/mutations` composes the Reconciliation, Category
keyword-rule, Memory, and statement-publication owners into one User-scoped D1 commit, derived from
the operation catalog so a new canonical mutation joins it without editing the unit. If an adapter is absent, canonical mutation execution returns the closed
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

### Current background execution

Onboarding email, browser-pairing email, email replacement, and billing collection each have a D1
outbox, Queue, and versioned Workflow. Their acceptance boundary schedules an identity-targeted
publication through the Core Worker's execution context after the durable commit. The continuation
has a two-second budget and cannot change the accepted response. It grants no authority and is not
the durability mechanism: the every-minute schedule reoffers eligible outbox identities, including
when the request ended before publication. Both paths share the same atomic publication cooldown.

Every scheduled dispatch, reconciliation, and retention activity is attempted independently. One
failure does not skip the remaining activities; the schedule reports a closed failure after all
activities finish. Provider ambiguity remains owned by the corresponding D1 lifecycle, never by a
blind resend. Queue acknowledgment confirms Workflow handoff, not successful provider delivery.

All five Core Queue consumers share a private dead-letter destination. A bounded operational inspection
observes the oldest eight pending records per owner, inspects stalled Workflow status, and reports
Queue dead-letter totals through metadata-only Cloudflare logs. A separate bounded sample of recent
rejected email work exposes delivery/proof rejection even when a Workflow completes successfully. Measurements that cannot be read
are explicitly unavailable. These signals are separate from the public reachability health response.
See the [background-work runbook](../../docs/operations/cloudflare-background-work.md).

Statement staging, atomic acceptance, extraction Queue/Workflow execution, public status and review
reads, and expiry are installed. The statement Workflow executes bounded chunks under the User
coordinator and settles supported material into Transactions or visible NeedsReviewItems. Its cron
reconciliation and dispatch run independently of the other activities, and its Workflow status and
dead letters are included in operational inspection. Financial content stays out of Queue payloads
and Workflow history. Forwarded-email ingress, private retention, and deterministic processing are installed.
Its identity-only Queue redelivers under the User coordinator; a bounded known format commits one
Transaction with its SourceAttestation, and uncertain, revoked, or interrupted work enters the
User-owned review read. Raw R2 bytes expire independently of the structural tag histogram,
which is retained only for successfully interpreted mail under a versioned allowlist approval policy.
Per-User and global rolling retention budgets supplement outstanding-work limits. Institution
Connection-state admission is not installed: this codebase has no institution Connection authority
or sender-to-institution mapping yet. Do not enable an Email Routing rule until that policy can
be enforced. The full hosted-Turn path still requires its own adapter and platform evidence.

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
  exercises Workers AI through its real binding; background-delivery tests cover identity-only Queue
  handoff, redelivery, provider ambiguity, prompt publication with cron recovery, and independent
  retention after dispatcher failure. Workflow activity tests do not by themselves prove live
  platform suspension or production alert delivery.

Tests whose only owner was a removed runtime or provider implementation are deleted. Portable
domain, schema, security, contract, browser, provider-boundary, and isolation evidence remains
authoritative.
