import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { MigrationSqlClient, MigratorLive } from "~/shell/db/client";
import { ClusterTopologyIncompatible, ensureClusterCompatibility } from "./cluster-compatibility";
import { productionRunnerTopology } from "./cluster-topology";

const runnerTopology = productionRunnerTopology({
  advertisedHost: "runner.internal",
  listenHost: "0.0.0.0",
  port: 34431,
});

/** The migration credential owns the identity table, so the test can isolate its writes. */
const MigrationRuntimeSqlClient = Layer.unwrap(
  Effect.map(MigrationSqlClient, (client) => Layer.succeed(SqlClient.SqlClient, client))
);

const CompatibilityHarness = MigrationRuntimeSqlClient.pipe(
  Layer.provideMerge(MigrationSqlClient.layer),
  Layer.provide(MigratorLive),
  Layer.provide(BunServices.layer)
);

layer(CompatibilityHarness, { excludeTestServices: true, timeout: "30 seconds" })(
  "durable Cluster topology compatibility",
  (it) => {
    it.effect("publishes exactly one identity and accepts any number of matching runners", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rollback = new Error("roll back the identity fixture");
        // The delete, both publishes, and the count run in one transaction. The transaction body
        // rolls back by dying, so an uncommitted identity never becomes visible to, or interferes
        // with, another test runtime.
        const exit = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM fidy_durable.cluster_topology_identity`;
              yield* ensureClusterCompatibility(runnerTopology.compatibility);
              yield* ensureClusterCompatibility(runnerTopology.compatibility);
              expect(
                yield* sql`SELECT count(*)::int AS count FROM fidy_durable.cluster_topology_identity`
              ).toEqual([{ count: 1 }]);
              return yield* Effect.die(rollback);
            })
          )
          .pipe(Effect.exit);
        assert.deepStrictEqual(exit, Exit.die(rollback));
      })
    );

    it.effect(
      "refuses an incompatible runner, names each differing field, and keeps the published identity",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const incompatible = {
            ...runnerTopology.compatibility,
            protocolGeneration: runnerTopology.compatibility.protocolGeneration + 1,
            shardsPerGroup: runnerTopology.compatibility.shardsPerGroup + 1,
            shardLockDisableAdvisory: !runnerTopology.compatibility.shardLockDisableAdvisory,
          };
          const rollback = new Error("roll back the incompatible fixture");
          const exit = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM fidy_durable.cluster_topology_identity`;
                yield* ensureClusterCompatibility(incompatible);
                assert.deepStrictEqual(
                  yield* ensureClusterCompatibility(runnerTopology.compatibility).pipe(
                    // A SQL failure here would hide the refusal this test proves.
                    Effect.catchTag("SqlError", Effect.die),
                    Effect.exit
                  ),
                  Exit.fail(
                    new ClusterTopologyIncompatible({
                      published: incompatible,
                      local: runnerTopology.compatibility,
                      differences: [
                        "protocolGeneration",
                        "shardsPerGroup",
                        "shardLockDisableAdvisory",
                      ],
                    })
                  )
                );
                expect(
                  yield* sql`SELECT protocol_generation AS "protocolGeneration"
                  FROM fidy_durable.cluster_topology_identity`
                ).toEqual([{ protocolGeneration: incompatible.protocolGeneration }]);
                return yield* Effect.die(rollback);
              })
            )
            .pipe(Effect.exit);
          assert.deepStrictEqual(exit, Exit.die(rollback));
        })
    );
  }
);
