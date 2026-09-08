/** Subprocess fixture: the parent kills this runner without running any finalizers. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema } from "effect";
import { ClusterWorkflowEngine, RunnerAddress } from "effect/unstable/cluster";
import { authenticatedClusterHttp } from "~/shell/authenticated-cluster-http";
import { PgLive } from "~/shell/db/client";
import { BrowserPairingEmailWorkflowLive } from "~/shell/email-authentication/authentication-delivery-worker";
import { EmailDeliveryPort } from "~/shell/email-authentication/delivery";
import {
  BrowserPairingEmailDeliveryWorkflow,
  BrowserPairingEmailExpiryWorkflow,
  PairingDeliveryPayload,
  PairingExpiryPayload,
} from "~/shell/email-authentication/pairing-email-execution";

const testSecretLength = 64;
const crashRunnerPort = 44643;
const cluster = authenticatedClusterHttp.layerSql("c".repeat(testSecretLength), {
  runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", crashRunnerPort)),
  runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", crashRunnerPort)),
  availableShardGroups: ["default"],
  assignedShardGroups: ["default"],
  shardsPerGroup: 300,
  entityMessagePollInterval: 50,
  sendRetryInterval: 50,
  runnerHealthCheckInterval: 100,
  refreshAssignmentsInterval: 100,
  shardLockRefreshInterval: 250,
  shardLockExpiration: "2 seconds",
});
const mode = Schema.decodeUnknownSync(Schema.Literals(["before-send", "after-send", "expiry"]))(
  process.argv[2]
);
const ready = Effect.sync(() => {
  process.stdout.write("crash-boundary-ready\n");
});
const provider = EmailDeliveryPort.of({
  send: () =>
    Effect.gen(function* () {
      // Before-send blocks before the fake external provider acts; after-send records acceptance.
      if (mode === "after-send") {
        yield* Effect.sync(() => {
          process.stdout.write("provider-accepted\n");
        });
      }
      yield* ready;
      return yield* Effect.never;
    }),
});
const Live = BrowserPairingEmailWorkflowLive.pipe(
  Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(cluster))),
  Layer.provide(PgLive),
  Layer.provide(Layer.succeed(EmailDeliveryPort, provider)),
  Layer.provide(BunServices.layer)
);
const program = Effect.gen(function* () {
  if (mode !== "expiry") {
    const payload = yield* Schema.decodeUnknownEffect(PairingDeliveryPayload)({
      revision: 1,
      userId: process.argv[3],
      intentId: process.argv[4],
    });
    yield* BrowserPairingEmailDeliveryWorkflow.execute(payload);
    return;
  }
  const payload = yield* Schema.decodeUnknownEffect(PairingExpiryPayload)({
    revision: 1,
    userId: process.argv[3],
    workflowId: process.argv[4],
  });
  yield* BrowserPairingEmailExpiryWorkflow.execute(payload, { discard: true });
  const executionId = yield* BrowserPairingEmailExpiryWorkflow.executionId(payload);
  for (;;) {
    const state = yield* BrowserPairingEmailExpiryWorkflow.poll(executionId);
    if (Option.isSome(state) && state.value._tag === "Suspended") break;
    yield* Effect.sleep("20 millis");
  }
  yield* ready;
  return yield* Effect.never;
});
// Isolated test-process entrypoint, intentionally terminated with SIGKILL by its parent.
// @effect-diagnostics-next-line strictEffectProvide:off
BunRuntime.runMain(program.pipe(Effect.provide(Live)));
