/** Subprocess fixture: the parent kills this runner with SIGKILL without running any finalizers. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Schedule } from "effect";
import { RunnerAddress, Sharding } from "effect/unstable/cluster";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { PgLive } from "~/shell/db/client";
import {
  clusterTestAuthenticationToken,
  clusterTestShardIds,
  clusterTestSharedOptions,
} from "./cluster-topology-fixtures";

const port = Number(process.argv[2]);
const cluster = authenticatedClusterHttp.layerSql(clusterTestAuthenticationToken, {
  ...clusterTestSharedOptions,
  runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
  runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
  shardLockRefreshInterval: 250,
  shardLockExpiration: "2 seconds",
  runnerHealthCheckInterval: 100,
  refreshAssignmentsInterval: 100,
});
const Live = cluster.pipe(Layer.provide(PgLive), Layer.provide(BunServices.layer));
const program = Effect.gen(function* () {
  const sharding = yield* Sharding.Sharding;
  // Hold at least one shard lock before reporting ready, so SIGKILL leaves durable lock state.
  yield* Effect.sync(() =>
    clusterTestShardIds.some((shardId) => sharding.hasShardId(shardId))
  ).pipe(
    Effect.repeat({ until: (ownsShard) => ownsShard, schedule: Schedule.spaced("50 millis") }),
    Effect.timeout("10 seconds"),
    Effect.orDie
  );
  yield* Effect.sync(() => {
    process.stdout.write("cluster-runner-ready\n");
  });
  return yield* Effect.never;
});
// Isolated test-process entrypoint, intentionally terminated with SIGKILL by its parent.
// @effect-diagnostics-next-line strictEffectProvide:off
BunRuntime.runMain(program.pipe(Effect.provide(Live)));
