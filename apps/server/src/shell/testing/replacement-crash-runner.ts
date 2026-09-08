import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Crypto, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/unstable/http";
import { Activity } from "effect/unstable/workflow";
import { EmailDeliveryPort } from "~/shell/email-authentication/delivery";
import { performReplacementAttempt } from "~/shell/email-authentication/replacement-delivery-worker";
import {
  ReplacementAttemptResult,
  ReplacementDeliveryPayload,
  ReplacementDeliveryWorkflow,
} from "~/shell/email-authentication/replacement-protocol";
import { replacementRuntimeLayer } from "./replacement-runtime";

/** Test-only runner: park at precise Activity boundaries so the parent can SIGKILL without finalizers. */
const run = Effect.gen(function* () {
  const options = yield* Config.all({
    payload: Config.string("TEST_REPLACEMENT_PAYLOAD"),
    phase: Config.literals(
      ["before-call", "after-call", "after-settlement"],
      "TEST_REPLACEMENT_PHASE"
    ),
    port: Config.port("TEST_REPLACEMENT_PORT"),
    providerUrl: Config.string("TEST_REPLACEMENT_PROVIDER_URL"),
    readyPath: Config.string("TEST_REPLACEMENT_READY_PATH"),
  });
  const payload = yield* Schema.decodeEffect(Schema.fromJsonString(ReplacementDeliveryPayload))(
    options.payload
  );
  const park = Effect.tryPromise(() => Bun.write(options.readyPath, "ready")).pipe(
    Effect.orDie,
    Effect.andThen(Effect.never)
  );
  const client = yield* HttpClient.HttpClient;
  const provider = EmailDeliveryPort.of({
    send: ({ combinedCode }) =>
      Effect.gen(function* () {
        if (options.phase === "before-call") return yield* park;
        yield* client
          .post(options.providerUrl, { body: HttpBody.text(combinedCode) })
          .pipe(Effect.orDie);
        if (options.phase === "after-call") return yield* park;
      }),
  });
  const deliveryLive = ReplacementDeliveryWorkflow.toLayer(
    Effect.fn(function* (input) {
      const result = yield* Activity.make({
        name: "DeliverReplacementEmail/1",
        success: ReplacementAttemptResult,
        execute: performReplacementAttempt(input, 1).pipe(
          Effect.tap(() => (options.phase === "after-settlement" ? park : Effect.void))
        ),
      });
      return result === "retry" ? ("rejected" as const) : result;
    })
  );
  const crypto = yield* Crypto.Crypto;
  const runtime = yield* Effect.acquireRelease(
    Effect.sync(() =>
      ManagedRuntime.make(
        replacementRuntimeLayer({ crypto, port: options.port, provider, deliveryLive })
      )
    ),
    (value) => Effect.tryPromise(() => value.dispose()).pipe(Effect.orDie)
  );
  yield* Effect.tryPromise(() =>
    runtime.runPromise(ReplacementDeliveryWorkflow.execute(payload, { discard: true }))
  );
  return yield* Effect.never;
});

BunRuntime.runMain(
  Layer.launch(
    Layer.effectDiscard(run).pipe(
      Layer.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))
    )
  )
);
