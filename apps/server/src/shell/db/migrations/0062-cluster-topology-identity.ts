import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Publishes the single Cluster topology compatibility contract for this deployment. */
export const clusterTopologyIdentity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fidy_durable.cluster_topology_identity (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      protocol_generation integer NOT NULL CHECK (protocol_generation > 0),
      shards_per_group integer NOT NULL CHECK (shards_per_group BETWEEN 1 AND 100000),
      available_shard_groups text[] NOT NULL
        CHECK (cardinality(available_shard_groups) BETWEEN 1 AND 16),
      serialization text NOT NULL CHECK (char_length(serialization) BETWEEN 1 AND 32),
      serialization_max_buffer_size integer NOT NULL
        CHECK (serialization_max_buffer_size BETWEEN 1 AND 1048576),
      message_storage_prefix text NOT NULL
        CHECK (char_length(message_storage_prefix) BETWEEN 1 AND 64),
      runner_storage_prefix text NOT NULL
        CHECK (char_length(runner_storage_prefix) BETWEEN 1 AND 64),
      shard_lock_disable_advisory boolean NOT NULL,
      shard_lock_expiration_millis integer NOT NULL
        CHECK (shard_lock_expiration_millis BETWEEN 1000 AND 3600000),
      recorded_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // The vitest harness drops only `public`, so migrations re-run over a kept `fidy_durable` schema.
  // A durable identity table created by an earlier revision of this migration gains the lock
  // columns here instead of failing the run; the backfill is the production lock configuration.
  yield* sql`
    ALTER TABLE fidy_durable.cluster_topology_identity
      ADD COLUMN IF NOT EXISTS shard_lock_disable_advisory boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS shard_lock_expiration_millis integer NOT NULL DEFAULT 35000
        CHECK (shard_lock_expiration_millis BETWEEN 1000 AND 3600000)
  `;
  yield* sql`
    GRANT SELECT, INSERT ON fidy_durable.cluster_topology_identity TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
