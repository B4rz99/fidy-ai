import { type Cause, Clock, Config, Effect, Schema } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage, observeRetentionCost } from "../d1-test-fixture";
import { maintenancePerformanceEnvironment } from "../maintenance-performance.test-fixture";
import { runCoreMaintenance } from "../maintenance/runtime";
import { seedHistory } from "./history-growth.test-fixture";
import { effectiveHistoryPage } from "./internal/effective-transaction";

const enabled =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const measurePage = (
  foreground: ReturnType<typeof observeRetentionCost>,
  subject: string,
  timings: number[]
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.gen(function* () {
    const page = effectiveHistoryPage({
      userId: subject,
      where: "user_id = ?",
      bindings: [subject],
      limit: 101,
    });
    const before = performance.now();
    const result = yield* Effect.tryPromise(() =>
      foreground.database
        .prepare(page.sql)
        .bind(...page.bindings)
        .all()
    );
    timings.push(performance.now() - before);
    expect(result.results).toHaveLength(101);
    expect(result.meta.rows_read).toBeLessThan(500);
  });
it.skipIf(!enabled)(
  "measures foreground History while complete maintenance drains expired evidence",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const subject = "10000000-0000-4000-8000-000000000051";
        for (const sample of [0, 1, 2, 3, 4, 5]) {
          const withMaintenance = sample % 2 === 1;
          const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
          yield* Effect.tryPromise(() => installTestSchema({ db }));
          yield* Effect.tryPromise(() =>
            db
              .prepare(`INSERT INTO users
        (id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)`)
              .bind(subject)
              .run()
          );
          yield* seedHistory({
            spacingMinutes: 20,
            db,
            subject,
            transactionPrefix: "20000000-0000-4000-8000-",
            count: 20_000,
            linked: true,
            linkedFraction: 1,
          });
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.tryPromise(() =>
            db.batch([
              db
                .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4096)
          INSERT INTO resource_admission_events(grant_id,policy_key,dimension,scope_key,policy_kind,units,admitted_at_epoch_ms,window_start_epoch_ms,expires_at_epoch_ms,released_at_epoch_ms) SELECT 'workers-ai-expired-'||i, 'workers-ai',
          'operation','test','rolling_window',1,?,?,?,NULL FROM n`)
                .bind(now - 90_000_000, now - 90_000_000, now - 1),
              db
                .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<4096)
          INSERT INTO resource_admission_grants SELECT 'workers-ai-expired-'||i,?,1 FROM n`)
                .bind(now - 90_000_000),
              db
                .prepare(
                  "INSERT INTO operational_health_view(operation,state,observed_at_ms,last_succeeded_ms) VALUES ('queueExecution','healthy',?1,?1),('workflowExecution','healthy',?2,?2)"
                )
                .bind(now, now),
            ])
          );
          const maintenance = observeRetentionCost(db);
          const foreground = observeRetentionCost(db);
          const timings: number[] = [];
          const queue: Queue = {
            send: () =>
              Promise.resolve({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
            sendBatch: () => Promise.reject(new Error("Unexpected product delivery")),
            metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
          };
          const unavailable = (): Promise<never> =>
            Promise.reject(new Error("Unexpected Workflow"));
          const workflow: Workflow = {
            get: unavailable,
            create: unavailable,
            createBatch: unavailable,
            deleteBatch: unavailable,
          };
          const environment = maintenancePerformanceEnvironment({
            db: maintenance.database,
            bucket,
            queue,
            workflow,
          });
          const started = performance.now();
          yield* Effect.all(
            [
              Effect.forEach(
                Array.from({ length: 128 }, (_, index) => index),
                () => measurePage(foreground, subject, timings),
                { concurrency: 8, discard: true }
              ),
              withMaintenance
                ? Effect.forEach(
                    Array.from({ length: 8 }, (_, index) => index),
                    () => runCoreMaintenance(environment),
                    { discard: true }
                  )
                : Effect.void,
            ],
            { concurrency: 2 }
          );
          timings.sort((left, right) => left - right);
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                scenario: Schema.Literal("maintenance-foreground"),
                sample: Schema.Int,
                withMaintenance: Schema.Boolean,
                requests: Schema.Int,
                concurrency: Schema.Int,
                elapsedMs: Schema.Finite,
                p50Ms: Schema.Finite,
                p95Ms: Schema.Finite,
                p99Ms: Schema.Finite,
                foregroundReads: Schema.Int,
                foregroundWrites: Schema.Int,
                maintenanceReads: Schema.Int,
                maintenanceWrites: Schema.Int,
                remainingExpired: Schema.Int,
              })
            )
          )({
            scenario: "maintenance-foreground",
            sample,
            withMaintenance,
            requests: 128,
            concurrency: 8,
            elapsedMs: performance.now() - started,
            p50Ms: timings[63] ?? 0,
            p95Ms: timings[121] ?? 0,
            p99Ms: timings[126] ?? 0,
            foregroundReads: foreground.cost().rowsRead,
            foregroundWrites: foreground.cost().rowsWritten,
            maintenanceReads: maintenance.cost().rowsRead,
            maintenanceWrites: maintenance.cost().rowsWritten,
            remainingExpired: yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "SELECT count(*) AS remaining FROM resource_admission_grants WHERE id GLOB 'workers-ai-expired-*'"
                )
                .first<number>("remaining")
            ).pipe(Effect.map((count) => count ?? 0)),
          });
          yield* Effect.sync(() => process.stdout.write(`INFRA_COST ${encoded}\n`));
        }
      })
    ),
  180_000
);
