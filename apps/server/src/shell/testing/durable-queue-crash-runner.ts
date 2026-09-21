import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { PgLive } from "./database-harness";
import { durableQueueTableName } from "~/shell/durable-queue-policy";

const TestPayload = Schema.Struct({ note: Schema.String });
const CrashRunnerHarness = PersistedQueue.layer.pipe(
  Layer.provideMerge(
    PersistedQueue.layerStoreSql({
      tableName: durableQueueTableName,
      pollInterval: "10 millis",
      lockRefreshInterval: "50 millis",
      lockExpiration: "2 seconds",
    })
  ),
  Layer.provideMerge(PgLive),
  Layer.provide(BunServices.layer)
);

const program = Effect.gen(function* () {
  const queueName = yield* Config.String("DURABLE_QUEUE_NAME");
  const testQueue = yield* PersistedQueue.make({ name: queueName, schema: TestPayload });
  return yield* testQueue.take(() =>
    Effect.sync(() => {
      process.send?.("lease-acquired");
    }).pipe(Effect.andThen(Effect.never))
  );
});

// Isolated test-process entrypoint, intentionally terminated with SIGKILL by its parent.
// @effect-diagnostics-next-line strictEffectProvide:off
BunRuntime.runMain(program.pipe(Effect.provide(CrashRunnerHarness)));
