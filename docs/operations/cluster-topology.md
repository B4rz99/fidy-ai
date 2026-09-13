# Cluster topology

Production runs one Bun process per Railway replica, each running a single SQL-backed Effect Cluster
runner. This document is the deployment contract for that substrate: the explicit Sharding topology,
the compatibility identity every process validates before taking shard ownership, readiness, and the
bounded telemetry operators use to detect stalled ownership or a filling durable mailbox.

Source of truth: [`apps/server/src/shell/cluster-topology.ts`](../../apps/server/src/shell/cluster-topology.ts)
(topology and identity), [`cluster-compatibility.ts`](../../apps/server/src/shell/cluster-compatibility.ts)
(publish/validate gate), [`cluster-readiness.ts`](../../apps/server/src/shell/cluster-readiness.ts)
(readiness probes), and [`cluster-observation.ts`](../../apps/server/src/shell/cluster-observation.ts)
with [`cluster-telemetry.ts`](../../apps/server/src/shell/cluster-telemetry.ts)
(telemetry). Only the runner's own advertised and listen addresses come from environment variables; no
environment variable selects a shared Sharding setting, so changing the topology is a code change
reviewed with this document.

## Runner topology

The shared topology is typed `Omit<ShardingConfig, "runnerAddress" | "runnerListenAddress" |
"assignedShardGroups">`, so every ownership, polling, capacity, shutdown, lock-recovery, and retry
setting is listed here and a new upstream setting is a type error until it is chosen deliberately.

| Setting                       | Value                                               | Why                                                                                                    |
| ----------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `shardsPerGroup`              | `300`                                               | Bounds per-refresh lock traffic while spreading resident entities across a shard group.                |
| `availableShardGroups`        | `["default"]`                                       | One group is the whole hash ring; every runner hashes the same shard set.                              |
| `assignedShardGroups`         | `["default"]` runner                                | Clients assign none. A runner owns only what the hash ring assigns it.                                 |
| `runnerShardWeight`           | `1`                                                 | Equal-weight replicas; no replica is preferred for ownership.                                          |
| `preemptiveShutdown`          | `true`                                              | A graceful stop begins as soon as one entity starts shutting down.                                     |
| `shardLockRefreshInterval`    | 10 seconds                                          | Refresh cadence kept at one third of the 35-second expiry with margin.                                 |
| `shardLockExpiration`         | 35 seconds                                          | Survives one dropped database connection without releasing ownership.                                  |
| `shardLockDisableAdvisory`    | `true`                                              | Row locks only; advisory locks are not part of the durable agreement.                                  |
| `entityTerminationTimeout`    | 15 seconds                                          | Entity shutdown finishes well before lock expiry, so a graceful stop releases locks deterministically. |
| `entityMailboxCapacity`       | `4096`                                              | Bounds in-memory mailbox depth per resident entity.                                                    |
| `maxResidentEntities`         | `10000`                                             | Bounds runner memory; at capacity, new addresses wait in durable storage instead of being admitted.    |
| `unprocessedMessageBatchSize` | `1024`                                              | Bounds one storage poll.                                                                               |
| `entityMaxIdleTime`           | 1 minute                                            | Idle resident entities release capacity.                                                               |
| `entityRegistrationTimeout`   | 1 minute                                            | A message whose entity never registers is failed rather than retried forever.                          |
| `entityMessagePollInterval`   | 10 seconds                                          | Durable mailbox poll cadence for resident entities.                                                    |
| `entityReplyPollInterval`     | 200 milliseconds                                    | Client reply poll cadence; interactive Turns wait on this.                                             |
| `sendRetryInterval`           | 100 milliseconds                                    | Retry cadence after `EntityNotAssignedToRunner` while ownership settles.                               |
| `refreshAssignmentsInterval`  | 3 seconds                                           | Runner and assignment refresh; bounds hand-over latency after a graceful stop.                         |
| `runnerHealthCheckInterval`   | 1 minute                                            | Heartbeat and unhealthy-runner reporting cadence.                                                      |
| `simulateRemoteSerialization` | `true`                                              | Every send crosses the serialization boundary, so local and remote delivery behave identically.        |
| `runnerAddress`               | `FIDY_CLUSTER_RUNNER_HOST:FIDY_CLUSTER_RUNNER_PORT` | Address other runners use to route RPC to this runner.                                                 |
| `runnerListenAddress`         | `FIDY_CLUSTER_LISTEN_HOST:FIDY_CLUSTER_RUNNER_PORT` | Bind address; defaults to `0.0.0.0`. The listener must stay private.                                   |
| serialization                 | `msgpack`, 64 KiB                                   | The only approved frame codec and the maximum encoded frame.                                           |

Required environment: `FIDY_CLUSTER_RUNNER_HOST`, `FIDY_CLUSTER_RUNNER_PORT`, optional
`FIDY_CLUSTER_LISTEN_HOST`, and `FIDY_CLUSTER_AUTH_TOKEN` (exactly 32 bytes as 64 lowercase
hexadecimal characters). The token authenticates every request to the private `/_fidy/cluster`
runner route; it must never appear in telemetry or logs.

## Compatibility identity

Before the Cluster layer builds, each process calls
`ensureClusterCompatibility`. The first process inserts one row into
`fidy_durable.cluster_topology_identity`; every later process compares the published row against its
own identity and fails startup closed with `ClusterTopologyIncompatible` naming each differing field.
The process-level failure reports that refusal once, before any Cluster infrastructure builds. The
runtime never overwrites a published row.

| Field                        | Meaning                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `protocolGeneration`         | Deployment generation of the entity/RPC/workflow schema.                     |
| `shardsPerGroup`             | Size of each hash-ring group.                                                |
| `availableShardGroups`       | Sorted set of groups every runner hashes.                                    |
| `serialization`              | Frame codec (`msgpack`).                                                     |
| `serializationMaxBufferSize` | Maximum encoded frame size in bytes.                                         |
| `messageStoragePrefix`       | Durable mailbox table namespace.                                             |
| `runnerStoragePrefix`        | Runner registry and shard-lock table namespace.                              |
| `shardLockDisableAdvisory`   | Whether shard locks use row locks only or also PostgreSQL advisory locks.    |
| `shardLockExpirationMillis`  | Staleness window after which another runner may take over an unrenewed lock. |

Addresses, listener addresses, `assignedShardGroups`, `runnerShardWeight`, the bearer token, and
purely local timing overrides are deliberately excluded: two replicas may differ on all of them and
still share one consistent hash ring and mailbox. Lock mode and lock expiration are included because
they select the lock mechanism and the staleness window every runner uses to decide whether another
runner's shards are free; runners that disagree would acquire disjoint lock sets and could each
believe they own the same shard. Telemetry and the refusal error contain only these field names and
values — never addresses, payloads, entity ids, User ids, or Secrets.

`protocolGeneration` is a deliberate constant, not a per-build digest. Additive-compatible releases
keep the same generation. Changing any identity field — including bumping the generation — is a
coordinated replacement owned by the release that makes the change; there is no compatible
intermediate state:

1. Scale the service to zero and wait until the platform reports no running replica. A mixed fleet
   is never valid: old and new processes refuse each other instead of sharing ownership.
2. Ship a release whose migration changes the published row to the new identity. The runtime only
   inserts the row when the table is empty and never overwrites it, so the row can only change
   through the migration credential.
3. Start the new runners. Each validates against the updated row, or publishes the new identity if
   the migration deleted the row. Release automation runs these three steps as one ordered
   procedure; do not roll a new runtime out before its migration has run on an empty fleet.

A failed gate is intentional: a process that cannot agree on routing and storage never accepts shard
ownership and never reads or writes the durable mailbox.

## Readiness

`GET /health` answers whether the process is alive. `GET /ready` answers whether this runner can do
Cluster work, probing the same memoized services that serve traffic:

| Check            | Probe                                                                | False means                                                              |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `runnerState`    | `RunnerStorage.refresh` of this runner's address (a heartbeat write) | The runner cannot refresh its registration and may hold stale ownership. |
| `routing`        | `Runners.ping` of this runner's advertised address                   | Peers cannot route to this runner over the private transport.            |
| `messageStorage` | one `MessageStorage.requestIdForPrimaryKey` lookup                   | The durable mailbox is unusable.                                         |

It returns `200 {"status":"ready","checks":{...}}` only when all three checks pass, and
`503 {"status":"unready","checks":{...}}` otherwise. Each probe has a two-second deadline; a
missing, failed, or timed-out probe reports `false`, and a process without an advertised runner
address can never report `runnerState` or `routing`. Concurrent and repeated requests share one probe
execution for two seconds, so an unauthenticated readiness flood does not drive a heartbeat write,
internal RPC, and mailbox read per hit. The `runnerState` heartbeat refresh carries no shard ids and
is deliberately not counted as shard-lock traffic. The body carries booleans only, responses are
`no-store`, and a failing dependency never exposes SQL, addresses, or credentials. Readiness is
never a statement that the listener is bound. Test compositions without a durable Cluster substrate
(`TestRunner`-based memory layers) use the volatile readiness implementation instead.

## Telemetry

Each runner logs one structured observation at startup and then every 60 seconds:

`Observed Cluster topology` with the following fields, all bounded and dimension-free:

| Field                                                                 | Covers                                                                                                               |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `isShutdown`                                                          | Whether the runner is draining.                                                                                      |
| `runnersTotal`, `runnersHealthy`                                      | Runner health across the topology.                                                                                   |
| `assignedShards`, `expectedShards`, `unassignedShards`                | Shard ownership and assignment lag. `expectedShards` is this runner's weighted hash-ring share, not the whole group. |
| `shardLockFailures`, `shardLockRefreshAgeMillis`                      | Row-lock acquire failures and shard-carrying refresh failures, plus refresh recency.                                 |
| `mailboxUnprocessed`, `mailboxOldestAgeMillis`, `mailboxRedeliveries` | Durable mailbox depth, age, and redelivery of persisted Work requests.                                               |
| `residentEntities`, `residentCapacity`                                | Resident capacity: the limit and whether four fifths of it is used.                                                  |
| `queueRetriesTotal`, `queuePendingRetries`                            | Durable-queue retries (attempts after the first) and pending retries.                                                |
| `requestRetriesTotal`                                                 | Cross-runner request calls (sends and discard notifications) retried after a retryable routing failure.              |
| `retriesDelta`                                                        | Queue and request retries gained since the previous sample; absent on the first sample.                              |

Counts clamp at 1,000,000, ages clamp at one day, and absent readings — including unbounded capacity
and the first sample's rates — are omitted from the log record. A failed observation logs exactly
`Cluster observation unavailable` with `{ "error": "observation_failed" }` and no cause, payload,
address, entity id, or User id.

Operational reading:

- Rising `unassignedShards` means the runner is holding fewer shards than the healthy weighted ring
  assigns it: check database health and `runnersHealthy`. A steady fleet reports zero for every
  runner even though no single runner owns the whole group.
- Rising `mailboxOldestAgeMillis` or `mailboxUnprocessed` means admitted Work is not being drained.
- Rising `shardLockFailures` or `shardLockRefreshAgeMillis` means lock storage is failing and
  ownership may be lost; the runner logs `Shard lock storage is unhealthy` separately. The counter
  covers acquire and refresh failures; refresh recency is the ownership-loss signal.
- Rising `retriesDelta` queue retries mean durable queue work is failing and being retried; rising
  request retries mean cross-runner request calls keep missing their owner or runner. A short spike
  is a settling hand-over, a sustained rise means routing is broken. Persisted Work does not retry
  in flight: when a lost runner leaves it unprocessed, its redelivery appears under
  `mailboxRedeliveries` and `mailboxUnprocessed` instead.
- `residentCapacity` with `pressure: true` means resident entities are at four fifths of
  `maxResidentEntities`; new addresses wait durably until a slot frees.

## Recovery expectations

- **Deployment grace period**: the window the platform allows between SIGTERM and SIGKILL. It must
  be at least `entityTerminationTimeout` (15 seconds) plus one `refreshAssignmentsInterval`
  (3 seconds) so a gracefully draining runner always releases its locks before it is killed. The
  graceful-stop integration scenario runs at production cadence and requires a survivor to hold
  every shard within 15 seconds of shutdown returning.
- **Graceful stop**: `preemptiveShutdown` releases every shard lock and unregisters the runner.
  Surviving runners pick up the released shards on the next `refreshAssignmentsInterval`, so
  ownership moves within seconds and no lease has to expire.
- **Hard loss**: a killed runner leaves locks behind. Surviving runners take over once
  `shardLockExpiration` (35 seconds) passes, bounded by `refreshAssignmentsInterval` for the
  following refresh. A shard is never owned by two runners at once. Persisted Work and mailbox rows
  survive the kill: the hard-loss scenario in
  [`cluster-topology.integration.test.ts`](../../apps/server/src/shell/cluster-topology.integration.test.ts)
  routes a Workflow request to a shard the doomed runner owns, proves the request is persisted
  unprocessed, then proves the survivor completes it after the SIGKILL. The SIGKILL scenarios in
  [`replacement-workflow.integration.test.ts`](../../apps/server/src/shell/email-authentication/replacement-workflow.integration.test.ts)
  prove the same recovery before provider I/O, after provider acceptance, and after settlement
  before Activity persistence.
- **Rolling release**: replicas are replaced one at a time; each new runner validates the published
  identity before accepting ownership, so a fleet never splits a mailbox or hash ring.
