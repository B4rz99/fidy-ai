import { Data, Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql";
import {
  type ClusterCompatibilityField,
  ClusterCompatibilityIdentity,
  clusterCompatibilityDifferences,
} from "./cluster-topology";
import { topologyIdentityTable } from "./durable-tables";

/**
 * Refusal raised before a process can accept shard ownership or route work. It names the contract
 * fields that differ; identities contain no addresses, credentials, entity ids, or payloads.
 */
export class ClusterTopologyIncompatible extends Data.TaggedError("ClusterTopologyIncompatible")<{
  readonly differences: ReadonlyArray<ClusterCompatibilityField>;
  readonly published: ClusterCompatibilityIdentity;
  readonly local: ClusterCompatibilityIdentity;
}> {
  override get message(): string {
    return `Cluster topology incompatible: ${this.differences.join(", ")}`;
  }
}

/**
 * Publishes this process's routing and storage identity once, then refuses every later process that
 * disagrees before the Cluster layer can acquire shards or read the mailbox. The first process after
 * a fresh deployment writes the contract; later processes only compare against it, so a rolled-back
 * or misconfigured process cannot overwrite the published identity.
 */
export const ensureClusterCompatibility = (
  local: ClusterCompatibilityIdentity
): Effect.Effect<void, ClusterTopologyIncompatible | SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inserted = yield* sql`
      INSERT INTO fidy_durable.${sql(topologyIdentityTable)}
        (protocol_generation, shards_per_group, available_shard_groups, serialization,
          serialization_max_buffer_size, message_storage_prefix, runner_storage_prefix,
          shard_lock_disable_advisory, shard_lock_expiration_millis)
      VALUES (
        ${local.protocolGeneration}, ${local.shardsPerGroup}, ${local.availableShardGroups},
        ${local.serialization}, ${local.serializationMaxBufferSize},
        ${local.messageStoragePrefix}, ${local.runnerStoragePrefix},
        ${local.shardLockDisableAdvisory}, ${local.shardLockExpirationMillis}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING protocol_generation
    `;
    const published = yield* sql`
      SELECT protocol_generation AS "protocolGeneration",
        shards_per_group AS "shardsPerGroup",
        available_shard_groups AS "availableShardGroups",
        serialization,
        serialization_max_buffer_size AS "serializationMaxBufferSize",
        message_storage_prefix AS "messageStoragePrefix",
        runner_storage_prefix AS "runnerStoragePrefix",
        shard_lock_disable_advisory AS "shardLockDisableAdvisory",
        shard_lock_expiration_millis AS "shardLockExpirationMillis"
      FROM fidy_durable.${sql(topologyIdentityTable)}
      WHERE id = true
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ClusterCompatibilityIdentity))),
      // The table constraints make a malformed published row impossible; decoding it anyway would
      // only turn a deployment defect into a misleading validation failure.
      Effect.orDie
    );

    const row = published[0];
    if (row === undefined) {
      return yield* Effect.die(
        new Error(`Cluster topology identity is missing from fidy_durable.${topologyIdentityTable}`)
      );
    }
    const differences = clusterCompatibilityDifferences(row, local);
    if (differences.length > 0) {
      return yield* new ClusterTopologyIncompatible({ differences, published: row, local });
    }
    if (inserted.length > 0) {
      yield* Effect.logInfo("Published Cluster topology compatibility identity", {
        protocolGeneration: local.protocolGeneration,
        shardsPerGroup: local.shardsPerGroup,
        availableShardGroups: local.availableShardGroups,
      });
    }
  });
