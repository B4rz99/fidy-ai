# Effect owns durable execution

- **Status:** Accepted
- **Date:** 2026-09-02
- **Parent:** [Issue 458](https://github.com/B4rz99/fidy-ai/issues/458)

## Context

Fidy currently implements durable work separately in Ingestion, email authentication, onboarding,
WhatsApp, hosted Turns, and Subscription. Those implementations repeat queue rows, claim tokens,
leases, stale-claim recovery, polling, retry counters, due timestamps, session advisory locks, and
persisted execution statuses. PostgreSQL constraints and transactional locks also protect genuine
domain and security invariants, so replacing every use of database coordination would weaken the
system rather than simplify it.

Effect RC.112 already supplies the missing execution substrate: SQL-backed `PersistedQueue`, durable
`Workflow` and `Activity`, `DurableClock`, `DurableDeferred`, `DurableQueue`, and SQL-backed Cluster
entities and workflow execution. Their verified contracts and traps are recorded in
[the persisted-queue](../../.patterns/persisted-queue.md),
[workflow](../../.patterns/workflows.md), and [cluster](../../.patterns/cluster.md) references. The
baseline inventory and disposition of existing mechanisms is
[the durable-execution inventory](../architecture/durable-execution-inventory.md).

## Decision

Effect owns durable **execution mechanics**. Fidy continues to own domain state, domain decisions,
User authorization and RLS activation, immediate PostgreSQL invariants, provider idempotency and
reconciliation, retention policy, and safe observability.

Use:

- `PersistedQueue` for one independently retryable queue item;
- `Workflow` and named `Activity` steps for multi-step continuation, provider handoff, durable wait,
  compensation, or callback resumption;
- `DurableQueue` only when a workflow delegates work and must await its result;
- `DurableClock` for a wait whose continuation must survive process replacement;
- SQL-backed Cluster workflow execution for production workflows;
- a keyed Cluster entity when serial ownership of one stable resource is the real invariant;
- ordinary Effect `Semaphore`, `Queue`, `Schedule`, and scoped fibers only when restart loss and
  multi-instance independence cannot affect correctness.

Do not add a Fidy queue, workflow, lease, or runner framework over those interfaces. A production
Layer may compose configured Effect facilities and register owning definitions; it must not mirror
or hide Effect's execution model.

### PostgreSQL remains authoritative for immediate invariants

Retain a uniqueness constraint, atomic statement, row lock, transaction advisory lock, or
transaction only when the invariant must hold at commit. Examples include consuming one proof,
transitioning one domain lifecycle, allocating bounded capacity atomically with admission, ordering
Consent evidence, and protecting a User-owned revision. The protected body and lock remain fused in
one short transaction.

Do not hold a database transaction across model, email, messaging, billing, or other network work.
The hosted-Turn session lock is a migration target, not a precedent for another session lock. During
#462 implementation, the Forwarded Email Ingestion decision was refined: its specialized
cross-transaction Consent gate remains because it orders bounded provider/model egress with
revocation rather than owning workflow execution. Every later persistence step rechecks Consent
under the short subject transaction lock. A future User-keyed coordination replacement must prove
the same revocation ordering before deleting this gate. Cluster entities may replace broad
cross-transaction serialization; they do not replace constraints or locks that protect a commit-time
invariant.

### Production composition

Every server replica is a Cluster runner and client unless a deployment is explicitly configured as
client-only. Production uses:

- one memoized PostgreSQL `SqlClient` layer for domain writes, queue publication, workflow messages,
  and User-scoped transactions;
- one SQL `PersistedQueue` store with a stable Fidy-owned table name;
- SQL `MessageStorage` and SQL `RunnerStorage` under the stable `fidy_cluster` prefix;
- `ClusterWorkflowEngine` with every production workflow and entity definition registered on every
  runner that can own its shard group;
- one unique, private, mutually routable advertised runner address per replica;
- identical sharding, serialization, prefix, and schema configuration on all replicas;
- graceful Layer-scope shutdown within the deployment termination budget, with hard-loss recovery
  proved separately.

The queue store and a domain write are transactionally atomic only when both resolve the same
`SqlClient` service inside the same `sql.withTransaction` scope. A separately constructed client,
even for the same database, is not acceptable. Database-only Activities annotated for cluster
message transactions must use that same client and remain short. Provider Activities are never
transactional.

The runtime role may access only the execution tables and the existing RLS-constrained domain
surface. Effect's automatic SQL-store migrations must not cause a general DDL grant: the production
spike must prove either a dedicated execution schema/owner with narrowly bounded startup authority
or an equivalent predeployment path before the runtime is enabled. The table names, prefix, shard
count, and serialization are deployment contracts, not per-replica defaults.

Runner HTTP/WebSocket routes are infrastructure endpoints. They bind only to Railway's private
service network, are absent from public API routing, and require peer authentication independently
of entity ids, workflow ids, deferred tokens, or obscurity. The production spike must prove the
selected authenticated transport (for example, platform mTLS or a dedicated constant-time
shared-secret middleware) and fail closed when its configuration is absent.

### User isolation and stored data

Every persisted queue item, workflow input, Activity input, durable callback reference, and keyed
entity request that can reach User-owned data carries an explicit stable `UserId`. Execution identity,
entity identity, a provider reference, a deferred token, or possession of an opaque UUID is not
authorization.

Before touching User-owned rows, a worker or Activity must authorize its purpose and activate the
existing transaction-local User RLS context through `withUserTransaction` or a narrower reviewed
gateway. Cross-User claim selection may expose only a work identity plus `UserId`; it may not expose
payload content. Two-User negative tests are required at every migrated background seam.

Persist only the bounded projection needed to resume. Owning Schemas set field bounds and a 64 KiB
maximum encoded envelope is the repository ceiling; ordinary definitions should be materially
smaller. Do not persist Secrets, raw provider bodies, email or statement bodies, Transcripts,
WorkingContext, arbitrary User prose, broad domain objects, or unnecessary personal or financial
data in generic execution storage. Provider references and digests are preferred to copied evidence.
Every stored input, success, and expected failure is runtime-decoded before trusted use.

### Delivery, retries, and provider ambiguity

Queue leases and workflow replay provide at-least-once execution, not exactly-once external effects.
A provider can commit after Fidy sends a request and before the Activity reply is durably recorded.
Every external Activity therefore declares one of:

1. a stable provider-supported idempotency key;
2. reconciliation of an ambiguous outcome before another mutation;
3. explicitly accepted safe at-least-once behavior.

A timeout, interruption, transport failure, malformed response, or crash after dispatch is ambiguous
unless the provider contract proves otherwise. It must not be recorded as definitive failure or
retried as though nothing happened. Compensation is used only for a valid domain transition and is
itself idempotent and ambiguity-aware.

Retry policy is typed, bounded, and owned by the queue item or Activity. Exhaustion reaches an explicit
domain outcome such as a NeedsReviewItem or truthful delivery state; it does not remain an exhausted
queue row as the only visible outcome. Short in-attempt retries may remain process-local only when
restarting the whole attempt is known safe.

### Retention and replay

Effect's SQL queue retains completed and exhausted rows. SQL Cluster storage retains durable
requests, replies, and deduplication state. Neither store defines Fidy's retention policy.

Each definition records:

- the personal-data purpose and fields in its envelope;
- the terminal domain evidence that makes execution storage disposable;
- the minimum deduplication, callback, reconciliation, and operator-replay horizon;
- a bounded cleanup operation and operational alert for overdue state.

Cleanup never treats age alone as proof that a running, suspended, callback-waiting, or ambiguously
settled execution is terminal. `clearReplies` and `clearAddress` are lifecycle tools, not a blanket
TTL. No generic replay endpoint may accept arbitrary payloads; operational replay reuses the owning
Schema, authorization purpose, and stable idempotency identity.

### Schema evolution and deployment

Persisted execution data must be coordinated across a deployment even though Fidy is unreleased.
Workflow tags, Activity names, entity types, queue names, idempotency keys, primary-key functions,
table prefixes, and shard configuration remain stable while relevant work exists.

Payloads carry a discriminated version. An incompatible change first drains the affected execution
or translates its stored envelope under an explicit migration, then deploys the replacement
definition and removes the superseded one. During a rolling rollout, old and new runners may overlap
only when they use the same definition and envelope version. Fixtures prove decoding for every
version that is currently pending, not compatibility with historical releases. Persisted values are
never repaired by casting decoded data.

### Observability

Observe each durable Work at its owning shell orchestration seam. Export only closed,
low-cardinality coordinates: queue/workflow kind, Activity name, bounded attempt, safe outcome,
retryability, latency, and provider code where already allowlisted. Never export payloads, User ids,
entity ids, execution ids, provider bodies, callback/deferred tokens, email addresses, prose,
financial content, or Secrets. Hashing a stable User or execution id does not make it a safe metric
label.

Operators need bounded counts and ages for pending, suspended, retrying, exhausted, ambiguous, and
terminal work; runner health; shard ownership; lock refresh failures; mailbox depth; and retention
lag. Logs report one failure at the owning Work boundary, not once at every retry layer.

## Migration and contraction

Migration is expand–migrate–contract. A work item is eligible in exactly one execution system at a
time. Publication first switches atomically to Effect, old pending work is drained or deliberately
translated, behavior and crash tests prove the cutover, and only then are old claims, leases,
pollers, retry fields, and execution-only statuses removed.

The order is:

1. [#460](https://github.com/B4rz99/fidy-ai/issues/460) proves the complete SQL-backed runtime with
   onboarding email delivery.
2. [#461](https://github.com/B4rz99/fidy-ai/issues/461) moves statement Ingestion to
   `PersistedQueue`.
3. [#462](https://github.com/B4rz99/fidy-ai/issues/462),
   [#463](https://github.com/B4rz99/fidy-ai/issues/463), and
   [#464](https://github.com/B4rz99/fidy-ai/issues/464) move Forwarded Email Ingestion and both email
   authentication deliveries to workflows.
4. [#465](https://github.com/B4rz99/fidy-ai/issues/465),
   [#466](https://github.com/B4rz99/fidy-ai/issues/466), and
   [#467](https://github.com/B4rz99/fidy-ai/issues/467) replace hosted-Turn, disclosure, and inbound
   WhatsApp execution coordination.
5. [#468](https://github.com/B4rz99/fidy-ai/issues/468) introduces workflows for implemented
   provider-backed Subscription work; BillingAttempt is included when its owning flow exists.
6. [#469](https://github.com/B4rz99/fidy-ai/issues/469) consolidates expiry and retention scheduling,
   and [#470](https://github.com/B4rz99/fidy-ai/issues/470) evaluates shared-store `RateLimiter`
   adoption without weakening transaction-coupled controls.
7. [#471](https://github.com/B4rz99/fidy-ai/issues/471) deletes obsolete shared machinery and adds the
   mechanical guard.

Contraction for a slice requires net deletion, no dual eligibility, no execution-only state left
without a documented owner, crash and two-runtime evidence, and an updated inventory. Domain
lifecycle and provider evidence remain when they still explain a User-visible or security outcome.

## Rejected alternatives

- **Keep bespoke SQL workers because PostgreSQL already makes them durable:** rejected because each
  slice would continue reimplementing delivery, retry, recovery, shutdown, and coordination.
- **Wrap Effect in a generic Fidy durable-work framework:** rejected because it recreates the
  abstraction and hides the semantics agents and reviewers need to see.
- **Replace every PostgreSQL lock with Cluster:** rejected because Cluster serialization cannot
  replace commit-time uniqueness, constraints, atomic transitions, RLS, or short transactional
  lock ordering.
- **Use in-memory workflow, queue, entity, or rate-limit storage in production:** rejected because
  overlapping replicas and process loss are correctness events.
- **Treat workflow replay as exactly-once provider delivery:** rejected because provider commit and
  durable Activity settlement are not atomic.
- **Hold a transaction across a provider call:** rejected because it cannot remove provider
  ambiguity and pins locks and connections across hostile latency.
