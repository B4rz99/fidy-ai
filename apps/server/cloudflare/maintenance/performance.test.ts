import { Clock, Config, Effect, Exit, Logger, Option, Schema, Tracer } from "effect";
import { afterAll, expect, it } from "vitest";
import { installTestSchema, isolatedTestStorage, observeRetentionCost } from "../d1-test-fixture";
import { maintenancePerformanceEnvironment } from "../maintenance-performance.test-fixture";
import { runCoreMaintenance, runEmailMaintenance } from "./runtime";

const enabled =
  Effect.runSync(Config.String("INFRA_PERFORMANCE_MEASURE").pipe(Config.withDefault("0"))) === "1";
const storage = isolatedTestStorage();
afterAll(() => storage.dispose());
const Activity = Schema.Struct({
  operation: Schema.String,
  rowsRead: Schema.Int,
  rowsWritten: Schema.Int,
  elapsedMs: Schema.Finite,
  successful: Schema.Boolean,
});
const measurement = Schema.fromJsonString(
  Schema.Struct({
    scenario: Schema.Literal("complete-maintenance"),
    retainedAdmissions: Schema.Int,
    expiredAdmissions: Schema.Int,
    remainingExpiredAdmissions: Schema.Int,
    tick: Schema.Int,
    rowsRead: Schema.Int,
    rowsWritten: Schema.Int,
    queueOffers: Schema.Int,
    queueMetricCalls: Schema.Int,
    workflowCalls: Schema.Int,
    elapsedMs: Schema.Finite,
    activities: Schema.Array(Activity),
  })
);

it.skipIf(!enabled)(
  "measures every Core maintenance activity with configured idle capabilities",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const { retainedAdmissions, expiredAdmissions } of [
          { retainedAdmissions: 0, expiredAdmissions: 0 },
          { retainedAdmissions: 2_000, expiredAdmissions: 0 },
          { retainedAdmissions: 20_000, expiredAdmissions: 0 },
          { retainedAdmissions: 20_000, expiredAdmissions: 4_096 },
        ]) {
          const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
          yield* Effect.tryPromise(() =>
            installTestSchema({
              db,
              sources: Array.from(
                new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
              )
                .sort()
                .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
            })
          );
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.tryPromise(() =>
            db.batch([
              db
                .prepare(
                  "INSERT INTO operational_canary VALUES ('queueExecution', ?), ('workflowExecution', ?)"
                )
                .bind(now, now),
              ...(retainedAdmissions === 0
                ? []
                : [
                    db
                      .prepare(`WITH RECURSIVE n(i) AS (
          SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
          INSERT INTO resource_admission_events SELECT 'retained-' || i, 'workers-ai', 'operation',
            'test', 'rolling_window', 1, ?, ?, ?, NULL FROM n`)
                      .bind(retainedAdmissions, now, now, now + 3_600_000),
                    db
                      .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
          INSERT INTO resource_admission_grants SELECT 'retained-' || i, ?, 1 FROM n`)
                      .bind(retainedAdmissions, now),
                  ]),
            ])
          );
          if (expiredAdmissions > 0) {
            yield* Effect.tryPromise(() =>
              db.batch([
                db
                  .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
                INSERT INTO resource_admission_events
                SELECT 'workers-ai-expired-' || i, 'workers-ai', 'operation', 'test', 'rolling_window',
                  1, ?, ?, ?, NULL FROM n`)
                  .bind(expiredAdmissions, now - 90_000_000, now - 90_000_000, now - 1),
                db
                  .prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
                INSERT INTO resource_admission_grants
                SELECT 'workers-ai-expired-' || i, ?, 1 FROM n`)
                  .bind(expiredAdmissions, now - 90_000_000),
              ])
            );
          }
          let queueOffers = 0;
          let queueMetricCalls = 0;
          let workflowCalls = 0;
          const queue: Queue = {
            send: () => {
              queueOffers++;
              return Promise.resolve({
                metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
              });
            },
            sendBatch: () => {
              throw new Error("Idle maintenance must not send product batches");
            },
            metrics: () => {
              queueMetricCalls++;
              return Promise.resolve({ backlogCount: 0, backlogBytes: 0 });
            },
          };
          const unexpectedWorkflow = (): Promise<never> => {
            workflowCalls++;
            return Promise.reject(new Error("Idle maintenance must not invoke product Workflows"));
          };
          const workflow: Workflow = {
            get: unexpectedWorkflow,
            create: unexpectedWorkflow,
            createBatch: unexpectedWorkflow,
            deleteBatch: unexpectedWorkflow,
          };
          for (const tick of [0, 1, 2, 3, 4]) {
            const measured = observeRetentionCost(db);
            const activities: Array<typeof Activity.Type> = [];
            const tracer = Tracer.make({
              span(options): Tracer.Span {
                const span = new Tracer.NativeSpan(options);
                const before = measured.cost();
                const end = span.end.bind(span);
                span.end = (endTime, exit): void => {
                  end(endTime, exit);
                  if (Option.isSome(options.parent)) return;
                  const after = measured.cost();
                  activities.push({
                    operation: options.name,
                    rowsRead: after.rowsRead - before.rowsRead,
                    rowsWritten: after.rowsWritten - before.rowsWritten,
                    elapsedMs: Number(endTime - options.startTime) / 1_000_000,
                    successful: Exit.isSuccess(exit),
                  });
                };
                return span;
              },
            });
            const environment = maintenancePerformanceEnvironment({
              db: measured.database,
              bucket,
              queue,
              workflow,
            });
            const started = yield* Clock.currentTimeMillis;
            const offersBefore = queueOffers;
            const metricsBefore = queueMetricCalls;
            yield* runCoreMaintenance(environment).pipe(
              Effect.withTracer(tracer),
              Effect.provideService(Logger.CurrentLoggers, new Set())
            );
            const ended = yield* Clock.currentTimeMillis;
            expect(activities.length).toBeGreaterThan(30);
            expect(activities.every((activity) => activity.successful)).toBe(true);
            if (tick > 0) {
              expect(
                activities.find((activity) => activity.operation === "patPairing.sweep")
                  ?.rowsWritten
              ).toBe(0);
            }
            expect(workflowCalls).toBe(0);
            const encoded = yield* Schema.encodeEffect(measurement)({
              scenario: "complete-maintenance",
              retainedAdmissions,
              expiredAdmissions,
              remainingExpiredAdmissions: yield* Effect.tryPromise(() =>
                db
                  .prepare(
                    "SELECT count(*) AS remaining FROM resource_admission_grants WHERE id GLOB 'workers-ai-expired-*'"
                  )
                  .first<number>("remaining")
              ).pipe(Effect.map((count) => count ?? 0)),
              tick,
              ...measured.cost(),
              queueOffers: queueOffers - offersBefore,
              queueMetricCalls: queueMetricCalls - metricsBefore,
              workflowCalls,
              elapsedMs: ended - started,
              activities,
            });
            yield* Effect.sync(() => process.stdout.write(`INFRA_COST ${encoded}\n`));
          }
        }
      })
    ),
  180_000
);

it.skipIf(!enabled)(
  "measures the complete idle Email maintenance tick",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db, bucket } = yield* Effect.tryPromise(() => storage.acquire());
        yield* Effect.tryPromise(() =>
          installTestSchema({
            db,
            sources: Array.from(
              new Bun.Glob("*.sql").scanSync(new URL("../migrations/", import.meta.url).pathname)
            )
              .sort()
              .map((name) => new URL(`../migrations/${name}`, import.meta.url)),
          })
        );
        for (const tick of [0, 1, 2]) {
          const measured = observeRetentionCost(db);
          const before = yield* Clock.currentTimeMillis;
          yield* runEmailMaintenance({
            DB: measured.database,
            EMAIL_BUCKET: bucket,
            EMAIL_QUEUE: {
              send: () => Promise.reject(new Error("Idle Email maintenance must not deliver")),
            },
          });
          const after = yield* Clock.currentTimeMillis;
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                scenario: Schema.Literal("email-maintenance"),
                tick: Schema.Int,
                rowsRead: Schema.Int,
                rowsWritten: Schema.Int,
                elapsedMs: Schema.Finite,
              })
            )
          )({ scenario: "email-maintenance", tick, ...measured.cost(), elapsedMs: after - before });
          yield* Effect.sync(() => process.stdout.write(`INFRA_COST ${encoded}\n`));
        }
      })
    ),
  30_000
);
