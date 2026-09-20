# Effect v4 persisted queues

> Source: `effect@4.0.0-rc.116` (`d62dd0d6…`) and the checked-in `.repos/effect` source. Post-rc.116 behavior is identified explicitly. Citations below are relative to `.repos/effect/packages/`.

Use this reference before replacing a PostgreSQL claim table, lease, polling loop, or retry worker with `effect/unstable/persistence/PersistedQueue`.

## The abstraction

A `PersistedQueue<A>` is a **named, schema-encoded work queue**. `offer` inserts by id; a duplicate `(queue name, id)` is ignored. `take(handler)` scopes one item: handler success completes it, failure retries it, and the default ceiling is 10 attempts (`effect/src/unstable/persistence/PersistedQueue.ts:63-100`, `:122-181`). The SQL migration enforces the identity with a unique `(id, queue_name)` index (`effect/src/unstable/persistence/PersistedQueue.ts:1093-1197`).

Create queues directly through `PersistedQueue.make({ name, schema })`; provide `PersistedQueue.layer` and one store layer. Do not add a Fidy queue interface that merely renames `offer` and `take` (`effect/src/unstable/persistence/PersistedQueue.ts:102-181`).

```ts
const queue =
  yield *
  PersistedQueue.make({
    name: "receipt-extraction",
    schema: ReceiptExtractionJob,
  });

// A stable domain id makes submission idempotent.
yield * queue.offer(job, { id: job.id });

// Run this repeatedly/concurrently under a scoped application worker.
yield * queue.take((job, { id, attempts }) => process(job, id, attempts));
```

## SQL semantics

Use the SQL store for correctness-critical production work. Its defaults are table `effect_queue`, 1-second polling, 30-second lock refresh, and 2-minute lock expiry. Each store instance gets a worker UUID; active scoped takes are refreshed in a background fiber (`effect/src/unstable/persistence/PersistedQueue.ts:753-793`, `:839-924`).

PostgreSQL acquisition atomically updates eligible rows selected in age order with `FOR UPDATE SKIP LOCKED`. Rows must be incomplete, below the caller's `maxAttempts`, and unlocked or expired (`effect/src/unstable/persistence/PersistedQueue.ts:939-965`). This replaces hand-built claim ownership, stale-claim recovery, poll sleeps, and competing-worker locks.

The take scope is the lease boundary. An attempt is consumed when the store claims an item,
not when its handler completes, so the first delivery observes `metadata.attempts === 1`.
A crashed worker therefore consumes an attempt (`effect/test/unstable/persistence/PersistedQueueTest.ts:49-53`,
`sql/pg/test/Persistence.integration.test.ts:155-180`). Then:

- success marks the row completed;
- non-interruption failure clears ownership and stores `Cause.pretty` in `last_failure`;
- interruption clears ownership and rolls back the claim attempt, so cancellation does not consume one;
- an expired final-attempt lease is eventually marked failed;
- finalizer writes retry up to five times and then defect if still unsuccessful
  (`effect/src/unstable/persistence/PersistedQueue.ts:428-480`,
  `sql/pg/test/Persistence.integration.test.ts:183-220`).

The implementation continuously retries poll-fiber defects after logging them. Closing its scope stops polling/refresh and unlocks items buffered by that store instance (`effect/src/unstable/persistence/PersistedQueue.ts:916-1039`). Therefore provide the store in an application-owned scope and let normal Layer shutdown close it; do not daemonize queue workers outside that scope.

### Transactional offer

An SQL queue `offer` is an ordinary statement issued through the captured `SqlClient` (`effect/src/unstable/persistence/PersistedQueue.ts:806-840`, `:1045-1056`). `SqlClient` resolves each statement's connection from the transaction service in the executing fiber, and `withTransaction` installs that service around the transaction body (`effect/src/unstable/sql/SqlClient.ts:142-176`, `:228-289`). Consequently, an offer executed inside `sql.withTransaction(...)` participates in that transaction **when the store and transaction use the same `SqlClient` identity**.

Use this to atomically mutate domain state and enqueue follow-up work. Prove rollback behavior in a PostgreSQL integration test for every such boundary; a differently constructed client or an offer outside the transaction is not coupled.

## Delivery contract

This is at-least-once processing, not exactly-once external effects. A worker can perform a provider call and die before queue completion is persisted; lock expiry then redelivers the item. Give the provider operation an idempotency key derived from the queue item id, or reconcile provider state before retrying. Do not hold a database transaction open across network work merely to mask this ambiguity.

`attempts` is the claim count including the current handler execution. Exhausted rows and
payloads that fail schema decoding are marked failed; failed rows are the store's dead-letter
records. There is no general public requeue/admin API. Build a narrow, explicit operational policy
if Fidy needs inspection, replay, or escalation. Do not update Effect's table casually from feature
code (`effect/src/unstable/persistence/PersistedQueue.ts:121-158`,
`effect/test/unstable/persistence/PersistedQueueTest.ts:87-101`, `:219-243`).

Classify failures before they leave the handler:

- transient operational/provider failures: fail with a redacted typed error so the item retries;
- permanent item/domain rejection: record the terminal domain outcome deliberately and let the handler succeed, or route to an explicit reviewed dead-letter capability;
- defects: surface and alert; do not convert every defect into an endless generic retry;
- shutdown/cancellation: preserve interruption so lease release does not consume an attempt.

`maxAttempts` is the delivery ceiling; `retrySchedule` controls when a failed element becomes
eligible again. The default is exponential delay starting at one second and capped at five minutes.
The persisted attempt count is replayed through the schedule, so delay progression survives worker
replacement (`effect/src/unstable/persistence/PersistedQueue.ts:132-191`). Supply a bounded schedule
when provider policy differs. A `Retry-After` value that must survive process loss needs explicit
persisted scheduling rather than an in-handler sleep. Ensure lock expiry exceeds any pause that still
occurs while the handler owns the lease and refresh remains healthy.

## Persistence and evolution traps

- The schema is used to encode on offer and decode after acquisition. A payload that cannot
  be decoded is immediately marked failed and skipped; its handler is not invoked, and later
  elements remain available (`effect/src/unstable/persistence/PersistedQueue.ts:121-158`,
  `effect/test/unstable/persistence/PersistedQueueTest.ts:219-243`). Use backward-readable
  codecs or drain/version a queue before incompatible changes.
- Queue names and custom ids are accepted as strings by the API, but the generated SQL columns are `VARCHAR(100)` and `VARCHAR(36)` respectively (`effect/src/unstable/persistence/PersistedQueue.ts:63-76`, `:1093-1163`). Keep names stable and ids within those limits. A UUID is the safest default.
- Payloads are JSON codec values stored as SQL text (`effect/src/unstable/persistence/PersistedQueue.ts:143-167`, `:1045-1056`). Persist identifiers and bounded facts, not credentials, unbounded provider bodies, browser state, or rich aggregates. Reload current domain state in the worker.
- `layerCleanup` runs store cleanup on a schedule. Completed rows are retained for
  `timeToLive`—30 days by default—so custom ids remain deduplicated across replay. Failed rows
  are retained indefinitely unless `failedTimeToLive` is configured. Removing a completed or
  failed row also removes its deduplication record; pending rows are not removed merely because
  they exceed the cleanup TTL (`effect/src/unstable/persistence/PersistedQueue.ts:293-328`,
  `effect/test/unstable/persistence/PersistedQueueTest.ts:245-316`). Run cleanup in one
  deployment instance; concurrent runs are safe but redundant.
- `last_failure` is `Cause.pretty(cause)`. Since it is durable and may contain error details, map provider failures to redacted typed errors before they reach `take` (`effect/src/unstable/persistence/PersistedQueue.ts:871-887`).
- Queue identity is global within the configured table, not User-scoped. Include an explicit `UserId` in the payload and activate the User database scope before loading domain state. Do not treat an opaque queue id as authorization.

## Configuration and testing

Tune lock expiry above the longest credible pause between refreshes, not merely the median handler time. Lock refresh is implemented and PostgreSQL integration tests verify that another store cannot steal a live item even when processing exceeds expiration (`sql/pg/test/Persistence.integration.test.ts:27-67`). Keep a generous relation between refresh and expiration and alert on repeated expiry/redelivery.

Use the shared behavioral contract as the testing model: duplicate custom ids, retry counts, max-attempt exhaustion, decode-failure attempts, interruption, and concurrent stores are all first-class cases (`effect/test/unstable/persistence/PersistedQueueTest.ts:33-221`). Fidy tests should additionally cover:

1. PostgreSQL transaction rollback removes both the domain mutation and queue offer.
2. two independent runtimes do not process one live lease concurrently;
3. forced process loss causes eventual redelivery;
4. provider idempotency/reconciliation makes that redelivery safe;
5. old encoded payloads still decode after deployment;
6. shutdown interrupts workers and releases work for a replacement.

Use `layerStoreMemory` only for tests where volatile process-local semantics are intended; it is explicitly in-memory and its behavior is not a substitute for PostgreSQL lock/integration tests (`effect/src/unstable/persistence/PersistedQueue.ts:233-316`).
