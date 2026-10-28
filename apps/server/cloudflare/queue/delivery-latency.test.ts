import { Config, Effect, Schema } from "effect";
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

it.skipIf(!measure)(
  "measures sparse native Queue delivery without waiting for a full batch",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const batchTimeoutSeconds of [5, 0]) {
          const runtime = yield* Effect.acquireRelease(
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
                          DB: { type: "d1", id: "sparse-queue-proof" },
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
              await env.DB.batch(batch.messages.map(message => env.DB.prepare('INSERT INTO deliveries(id) VALUES (?)').bind(message.id)));
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
          const db = yield* Effect.tryPromise(() => runtime.getD1Database("DB"));
          yield* Effect.tryPromise(() =>
            db.prepare("CREATE TABLE deliveries(id TEXT PRIMARY KEY) STRICT").run()
          );
          const started = performance.now();
          expect(
            (yield* Effect.tryPromise(() =>
              runtime.dispatchFetch("http://proof/", { method: "POST" })
            )).status
          ).toBe(202);
          let deliveries = 0;
          for (let attempt = 0; attempt < 200; attempt++) {
            deliveries =
              (yield* Effect.tryPromise(() =>
                db.prepare("SELECT count(*) AS count FROM deliveries").first<number>("count")
              )) ?? 0;
            if (deliveries === 1) break;
            yield* Effect.sleep(50);
          }
          const elapsedMs = performance.now() - started;
          const encoded = yield* Schema.encodeEffect(measurement)({
            batchTimeoutSeconds,
            elapsedMs,
            deliveries,
          });
          yield* Effect.sync(() => process.stdout.write(`INFRA_QUEUE_LATENCY ${encoded}\n`));
          expect(deliveries).toBe(1);
          if (batchTimeoutSeconds === 5) expect(elapsedMs).toBeGreaterThanOrEqual(4500);
          else expect(elapsedMs).toBeLessThan(2000);
        }
      }).pipe(Effect.scoped)
    ),
  30_000
);
