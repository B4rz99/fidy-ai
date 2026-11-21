import { type Cause, Config, Duration, Effect, Schema, type Scope } from "effect";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

const measure =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";

const measurement = Schema.fromJsonString(
  Schema.Struct({
    batchTimeoutSeconds: Schema.Int,
    elapsedMs: Schema.Finite,
    deliveries: Schema.Int,
  })
);

const sparseRuntime = (batchTimeoutSeconds: number): Effect.Effect<Miniflare, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new Miniflare({
          workers: [
            {
              config: {
                name: "sparse-queue-proof",
                type: "worker",
                compatibilityDate: "2026-09-08",
                env: {
                  RESULT: { type: "kv", id: "sparse-queue-timing" },
                  WORK: { type: "queue", name: "sparse-work" },
                },
                triggers: [
                  {
                    type: "queue",
                    name: "sparse-work",
                    maxBatchSize: 10,
                    maxBatchTimeout: batchTimeoutSeconds,
                    maxRetries: 3,
                  },
                ],
                manifest: {
                  mainModule: "index.mjs",
                  modules: {
                    "index.mjs": {
                      type: "esm",
                      contents: `export default {
    async fetch(request, env) { await env.WORK.send({version:1}); return new Response(null,{status:202}); },
    async queue(batch, env) {
      await Promise.all(batch.messages.map(message => env.RESULT.put(message.id,'delivered')));
      batch.ackAll();
    }
  };`,
                    },
                  },
                },
              },
            },
          ],
        })
    ),
    (runtime) => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie)
  );

const pollDeliveries = (
  result: Awaited<ReturnType<Miniflare["getKVNamespace"]>>,
  remaining: number
): Effect.Effect<number, Cause.UnknownError> =>
  Effect.tryPromise(() => result.list()).pipe(
    Effect.flatMap(({ keys }) =>
      keys.length === 1
        ? Effect.succeed(keys.length)
        : Effect.sleep(Duration.millis(50)).pipe(
            Effect.andThen(
              remaining <= 1 ? Effect.succeed(keys.length) : pollDeliveries(result, remaining - 1)
            )
          )
    )
  );

const measureDelivery = Effect.fnUntraced(function* (batchTimeoutSeconds: number) {
  const runtime = yield* sparseRuntime(batchTimeoutSeconds);
  const result = yield* Effect.tryPromise(() => runtime.getKVNamespace("RESULT"));
  const started = performance.now();
  expect(
    (yield* Effect.tryPromise(() => runtime.dispatchFetch("http://proof/", { method: "POST" })))
      .status
  ).toBe(202);
  const deliveries = yield* pollDeliveries(result, 200);
  const elapsedMs = performance.now() - started;

  const encoded = yield* Schema.encodeEffect(measurement)({
    batchTimeoutSeconds,
    elapsedMs,
    deliveries,
  });

  yield* Effect.sync(() => process.stdout.write(`INFRA_QUEUE_LATENCY ${encoded}\n`));

  return { deliveries, elapsedMs };
}, Effect.scoped);

it.skipIf(!measure)("measures sparse native Queue delivery without waiting for a full batch", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const [batched, sparse] = yield* Effect.all([measureDelivery(5), measureDelivery(0)]);
      expect([batched.deliveries, sparse.deliveries]).toEqual([1, 1]);
      expect(batched.elapsedMs).toBeGreaterThanOrEqual(4500);
      expect(sparse.elapsedMs).toBeLessThan(2000);
    })
  )
);
