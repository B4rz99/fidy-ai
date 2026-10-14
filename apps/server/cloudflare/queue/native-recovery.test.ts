import { Clock, Config, Effect, Schema } from "effect";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

const userId = "10000000-0000-4000-8000-000000000001";
const identity = (index: number): string =>
  `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
const count = (db: D1Database, table: string): Promise<number> =>
  db
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .first<number>("count")
    .then((value) => value ?? 0);
const waitForCount = Effect.fn(function* (db: D1Database, table: string, expected: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((yield* Effect.tryPromise(() => count(db, table))) >= expected) return;
    yield* Effect.sleep(100);
  }
  throw new Error(`Native Queue did not settle ${table}`);
});
const measureQueueGrowth =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
const queueMeasurement = Schema.fromJsonString(
  Schema.Struct({
    scenario: Schema.Literal("native-queue-recovery"),
    backlog: Schema.Int,
    deliveries: Schema.Int,
    deadLetters: Schema.Int,
    elapsedMs: Schema.Finite,
    handoffP50Ms: Schema.Finite,
    handoffP95Ms: Schema.Finite,
    handoffP99Ms: Schema.Finite,
  })
);
it(
  "recovers a native Queue backlog despite local batch retries without duplicate handoffs",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const built = yield* Effect.tryPromise(() =>
          Bun.build({
            entrypoints: [new URL("./recovery-worker.fixture.ts", import.meta.url).pathname],
            target: "browser",
            external: ["cloudflare:workers"],
          })
        );
        const output = built.outputs[0];
        if (!built.success || output === undefined) throw new Error("Queue proof bundle failed");
        const contents = yield* Effect.tryPromise(() => output.text());
        for (const backlog of measureQueueGrowth ? [10, 100, 1000] : [100]) {
          const runtime = yield* Effect.acquireRelease(
            Effect.sync(
              () =>
                new Miniflare({
                  workers: [
                    {
                      config: {
                        name: "native-recovery-proof",
                        type: "worker",
                        compatibilityDate: "2026-09-08",
                        env: {
                          DB: { type: "d1", id: "native-recovery-proof" },
                          WORK: { type: "queue", name: "recovery-work" },
                        },
                        triggers: [
                          {
                            type: "queue",
                            name: "recovery-work",
                            deadLetterQueue: "recovery-dead",
                            maxBatchSize: 10,
                            maxBatchTimeout: 0,
                            maxConcurrency: 1,
                            maxRetries: 3,
                            retryDelay: 0,
                          },
                          {
                            type: "queue",
                            name: "recovery-dead",
                            maxBatchSize: 10,
                            maxBatchTimeout: 0,
                          },
                        ],
                        manifest: {
                          mainModule: "index.mjs",
                          modules: { "index.mjs": { contents, type: "esm" } },
                        },
                      },
                    },
                  ],
                })
            ),
            (value) => Effect.tryPromise(() => value.dispose()).pipe(Effect.orDie)
          );
          const db = yield* Effect.tryPromise(() => runtime.getD1Database("DB"));
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.tryPromise(() =>
            db.batch([
              db.prepare(
                "CREATE TABLE statement_submissions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL, retention_expires_at_ms INTEGER NOT NULL, queued_at_ms INTEGER) STRICT"
              ),
              db.prepare("CREATE TABLE blocked(id TEXT PRIMARY KEY) STRICT"),
              db.prepare(
                "CREATE TABLE handoffs(id TEXT PRIMARY KEY, completed_at_ms INTEGER NOT NULL) STRICT"
              ),
              db.prepare(
                "CREATE TABLE deliveries(id TEXT NOT NULL, attempt INTEGER NOT NULL) STRICT"
              ),
              db.prepare(
                "CREATE TABLE dead_letters(id TEXT PRIMARY KEY, attempt INTEGER NOT NULL) STRICT"
              ),
            ])
          );
          yield* Effect.tryPromise(() =>
            db.batch([
              ...Array.from({ length: backlog }, (_, index) =>
                db
                  .prepare(
                    "INSERT INTO statement_submissions(id,user_id,status,retention_expires_at_ms) VALUES (?, ?, 'queued', ?)"
                  )
                  .bind(identity(index), userId, now + 600_000)
              ),
              db.prepare("INSERT INTO blocked VALUES (?)").bind(identity(4)),
            ])
          );
          const started = performance.now();
          expect(
            (yield* Effect.tryPromise(() =>
              runtime.dispatchFetch("http://proof/replay", { method: "POST" })
            )).status
          ).toBe(202);
          yield* waitForCount(db, "handoffs", backlog - 1);
          yield* waitForCount(db, "dead_letters", 10);
          expect(yield* Effect.tryPromise(() => count(db, "dead_letters"))).toBe(10);
          expect(yield* Effect.tryPromise(() => count(db, "deliveries"))).toBe(backlog + 30);
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT MAX(attempt) AS attempt FROM deliveries WHERE id = ?")
                .bind(identity(4))
                .first<number>("attempt")
            )
          ).toBe(4);
          expect(
            yield* Effect.tryPromise(() =>
              db
                .prepare("SELECT id FROM dead_letters WHERE id = ?")
                .bind(identity(4))
                .first<string>("id")
            )
          ).toBe(identity(4));
          yield* Effect.tryPromise(() => db.prepare("DELETE FROM blocked").run());
          expect(
            (yield* Effect.tryPromise(() =>
              runtime.dispatchFetch("http://proof/replay", { method: "POST" })
            )).status
          ).toBe(202);
          yield* waitForCount(db, "handoffs", backlog);
          yield* waitForCount(db, "deliveries", 2 * backlog + 30);
          expect(yield* Effect.tryPromise(() => count(db, "handoffs"))).toBe(backlog);
          expect(performance.now() - started).toBeLessThan(40_000);
          if (measureQueueGrowth) {
            const rows = yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT h.completed_at_ms-s.queued_at_ms AS delay FROM handoffs h JOIN statement_submissions s ON h.id=s.id ORDER BY delay"
                )
                .all()
            );
            const delays = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ delay: Schema.Finite }))
            )(rows.results);
            const quantile = (fraction: number): number =>
              delays[Math.ceil(delays.length * fraction) - 1]?.delay ?? 0;
            const encoded = yield* Schema.encodeEffect(queueMeasurement)({
              scenario: "native-queue-recovery",
              backlog,
              deliveries: yield* Effect.tryPromise(() => count(db, "deliveries")),
              deadLetters: yield* Effect.tryPromise(() => count(db, "dead_letters")),
              elapsedMs: performance.now() - started,
              handoffP50Ms: quantile(0.5),
              handoffP95Ms: quantile(0.95),
              handoffP99Ms: quantile(0.99),
            });
            yield* Effect.sync(() => process.stdout.write(`INFRA_QUEUE ${encoded}\n`));
          }
        }
      }).pipe(Effect.scoped)
    ),
  180_000
);
