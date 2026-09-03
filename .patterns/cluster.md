# Effect v4 Cluster and the production workflow engine

> Source: Effect checkout at `.repos/effect`, version RC.112. Citations below are relative to `.repos/effect/packages/`.

Use this reference before introducing `ClusterWorkflowEngine`, cluster entities, SQL message storage, multiple workflow runners, or a client-only cluster process.

## What Cluster owns

Effect Cluster maps a typed RPC **entity type + entity id** to a shard, assigns each shard to one runner, routes calls to that runner, and optionally persists request/reply mailboxes. An entity definition defaults to handler concurrency `1`, giving serial execution per resident entity unless explicitly changed (`effect/src/unstable/cluster/Entity.ts:611-639`). Use keyed entities where serial ownership of one aggregate is the actual abstraction; do not use a global entity as a replacement for all domain locking.

Persistence is opt-in per RPC: `ClusterSchema.Persisted` defaults to false. `ClusterSchema.WithTransaction` also defaults to false and only has transactional meaning if the configured message storage implements it (`effect/src/unstable/cluster/ClusterSchema.ts:17-61`). Do not assume “entity” means durable or transactional. Annotate intentionally and test process loss.

Cluster owns routing, mailbox deduplication, shard ownership, retries, and entity lifecycle. Fidy still owns User authorization/RLS activation, domain transaction boundaries, provider idempotency, payload bounds, and schema compatibility.

## Production topology

For multiple server replicas, every **runner** process needs:

1. a unique, stable, mutually routable advertised `runnerAddress`;
2. a listening runner transport (HTTP or WebSocket), optionally with a distinct bind `runnerListenAddress`;
3. one shared PostgreSQL database and the same cluster table prefix;
4. SQL `MessageStorage` and SQL `RunnerStorage`;
5. identical shard-count/group and serialization configuration;
6. the same registered workflow/entity definitions for every shard group it may own.

A **client-only** process routes calls but advertises no runner address, serves no runner endpoint, and receives no shard assignments (`effect/src/unstable/cluster/RunnerServer.ts:244-257`, `effect/src/unstable/cluster/HttpRunner.ts:257-340`). Use this for command/API processes only if workflow execution is intentionally isolated into dedicated runner deployments.

On Bun, `@effect/platform-bun/BunClusterHttp.layer` is the deep composition seam: it selects HTTP/WebSocket transport, MessagePack/NDJSON serialization, health checks, SQL/local/caller-provided storage, and client-only mode. SQL is the default; local storage chooses no-op message storage and in-memory runner storage and is not production durability (`platform/bun/src/BunClusterHttp.ts:58-176`). Prefer this layer over reassembling its internals unless Fidy needs a documented custom transport or storage boundary.

`SingleRunner.layer` still uses SQL message storage but supplies no-op routing and health; SQL runner storage is its default (`effect/src/unstable/cluster/SingleRunner.ts:45-76`). It is useful for an explicit one-runner deployment/proof, not a hidden promise that horizontally scaled replicas coordinate. Migration to multiple replicas must switch to a network runner layer and test cross-process routing.

## The two SQL stores have different jobs

### `SqlMessageStorage`

Message storage durably records encoded request envelopes, replies, delivery times, processing/deduplication state, trace context, and entity addresses. Its prefix defaults to `cluster`; the prefix also names its migration history. Changing it points the runtime at different durable state (`effect/src/unstable/cluster/SqlMessageStorage.ts:40-78`).

Saving a request uses its RPC primary key for deduplication and can return the original request/reply instead of inserting another request. Saving a reply updates request processing state and inserts the reply in one SQL transaction (`effect/src/unstable/cluster/SqlMessageStorage.ts:520-568`). This is how persisted workflow/activity calls survive retries; it does not make a provider side effect exactly once.

`clearReplies(requestId)` resets one request for processing; `clearAddress(address)` deletes all replies and messages for the entity address (`effect/src/unstable/cluster/SqlMessageStorage.ts:570-592`, `:714-736`). These are lifecycle mechanisms, not an automatic time-based retention service. No general TTL cleanup is installed by the store: workflow requests/replies and deduplication state otherwise remain durable. Define conservative, monitored retention only after proving which completed addresses can never be polled, resumed, deduplicated, or interrupted again.

### `SqlRunnerStorage`

Runner storage registers runner addresses/heartbeats and owns shard locks. On PostgreSQL and MySQL it uses a reserved connection and advisory locks by default; it can use lock rows when advisory locks are disabled. Scope finalization attempts to release advisory locks, and lock operations/rebuilds are deadline-bounded (`effect/src/unstable/cluster/SqlRunnerStorage.ts:90-179`, `:181-260`). Do not preserve Fidy's broad advisory-lock registry alongside this for the same execution ownership.

All runners sharing a cluster must use one runner-storage namespace and consistent shard configuration. `ShardingConfig.layer` is only a shallow merge and does not validate cross-runner agreement (`effect/src/unstable/cluster/ShardingConfig.ts:176-238`). Configuration drift can split expectations even when the database is shared.

## `ClusterWorkflowEngine`

Provide `ClusterWorkflowEngine.layer` (or build its engine) wherever workflow definitions are registered or invoked. It represents each execution as entity id `executionId` under entity type `Workflow/<workflow tag>`. Its `run`, activity, deferred, and resume RPCs are persisted; run/deferred are uninterruptible in the relevant directions (`effect/src/unstable/cluster/ClusterWorkflowEngine.ts:661-741`).

The engine's activity request has primary key `${activity name}/${attempt}` and dynamically enables message-storage transactions when the Activity carries `ClusterSchema.WithTransaction` (`effect/src/unstable/cluster/ClusterWorkflowEngine.ts:514-550`, `:661-680`). Use that annotation only for an activity whose database work truly must share the entity message transaction. Do not wrap provider network calls in it: a long SQL transaction cannot remove provider ambiguity and increases lock/connection risk.

Workflow entities use a short 10-second idle lifetime because completed/suspended state can be rebuilt from storage (`effect/src/unstable/cluster/ClusterWorkflowEngine.ts:700-741`). Memory residency is therefore a cache, not durable state. Never store correctness-critical workflow facts only in captured mutable variables or runner-local services.

## Shutdown and failover

Cluster's default configuration enables preemptive shutdown, refreshes shard locks every 10 seconds, expires them after 35 seconds, caps resident entities at 10,000, and polls persisted entity messages every 10 seconds (`effect/src/unstable/cluster/ShardingConfig.ts:176-207`). Defaults are not production capacity decisions.

Application shutdown must close the cluster Layer scope and leave enough grace for entity termination and runner finalizers. Then another healthy runner can acquire shards and recover persisted mailboxes. Validate behavior against the deployment platform's termination deadline. Test hard loss too: graceful finalizers cannot be the correctness mechanism.

Tune and alert on at least runner health, shard ownership/assignment lag, lock refresh failure, persisted mailbox age/depth, entity capacity, request retry rate, and workflow completion/suspension/failure. Keep entity type, workflow tag, and operation as bounded dimensions; never put entity ids, User ids, payloads, tokens, or provider bodies into metric labels.

## Security and User isolation

The ready-made runner server exposes the cluster RPC protocol over its configured HTTP/WebSocket route; its composition supplies serialization and transport but no Fidy authentication middleware is visible in that layer (`effect/src/unstable/cluster/HttpRunner.ts:103-223`, `platform/bun/src/BunClusterHttp.ts:130-176`). Bind it to a private authenticated service network, enforce ingress policy/mTLS at the platform boundary, and never expose it as a public application route.

Cluster storage is service infrastructure and cannot infer Fidy User ownership from generic envelopes. Use a narrowly privileged service role for cluster tables, separate their policy review from User-owned domain tables, and keep explicit `UserId` in every workflow/entity payload. Before any domain query or mutation, authorize the operation and activate that User's RLS scope. A routable entity id or workflow execution id is not authorization.

Persisted envelopes include payloads, headers, errors/results, and trace ids (`effect/src/unstable/cluster/SqlMessageStorage.ts:79-166`). Keep schemas bounded and secret-free, use an allowlist for propagated headers, and ensure typed errors are redacted before persistence. The SQL stores call `withoutTransforms`, so application row transforms are not a security boundary (`effect/src/unstable/cluster/SqlMessageStorage.ts:61-67`).

## Schema and deployment compatibility

Persisted RPC payloads and replies are decoded by the currently registered schemas. During a rolling deployment, old and new runners can encounter the same durable mailbox. Therefore:

- keep entity type, RPC tag, workflow name, and primary-key functions stable;
- make schema changes backward-readable across all in-flight messages;
- deploy readers before writers for additive formats;
- do not change shard count/groups, serialization, or table prefix casually;
- drain or migrate incompatible durable state before removing old readers.

Long primary keys are SHA-256 digested by SQL message storage after 255 characters; shorter keys remain plaintext for compatibility (`effect/src/unstable/cluster/SqlMessageStorage.ts:79-106`). This is storage encoding, not secrecy or authentication.

## Tests required before production

Use independent runtimes and PostgreSQL, not merely two Layers in one runtime. Prove:

1. two runners share shard ownership without concurrent handling of one serial entity;
2. a client routes to a remote owner and receives a persisted reply;
3. hard-killing the owner after a provider commit recovers safely via idempotency/reconciliation;
4. graceful termination transfers work within the deployment deadline;
5. completed and suspended workflows survive replacement of every runner;
6. rolling old/new schemas decode all in-flight requests and replies;
7. runner endpoints are unreachable from public ingress and unauthorized peers;
8. one User cannot cause a workflow/entity payload to access another User's domain rows;
9. retention removes only proven-terminal state without breaking deduplication or polling;
10. cluster metrics/logs remain bounded and secret-free.

The upstream Node integration harness builds multiple runner layers, client-only layers, and prefixed SQL runner storage; use it as the topology reference (`platform/node/test/cluster-integration/harness.ts:350-446`). The unit suites are useful for entity/message contracts but are not proof of deployment networking or PostgreSQL failover.
