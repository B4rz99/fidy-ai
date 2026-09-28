import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import {
  observeOperationalEventMetrics,
  sweepOperationalEventBuckets,
} from "./operational-event-metrics";

it.effect(
  "reports missing tail telemetry as unavailable instead of zero and classifies recent bounded counts",
  () =>
    Effect.scoped(
      Effect.acquireUseRelease(
        Effect.sync(
          () =>
            new Miniflare({
              workers: [
                {
                  config: {
                    name: "tail-metrics",
                    type: "worker",
                    compatibilityDate: "2026-09-08",
                    env: { DB: { id: "tail-metrics", type: "d1" } },
                    manifest: {
                      mainModule: "index.mjs",
                      modules: {
                        "index.mjs": {
                          contents: "export default {fetch() {return new Response('ok')}}",
                          type: "esm",
                        },
                      },
                    },
                  },
                },
              ],
            })
        ),
        (instance) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise(() => instance.ready);
            const db = yield* Effect.tryPromise(() => instance.getD1Database("DB"));
            yield* Effect.tryPromise(() =>
              db
                .prepare(
                  "CREATE TABLE operational_event_buckets (kind TEXT NOT NULL, bucket_ms INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, bucket_ms))"
                )
                .run()
            );
            const now = 1_800_000;
            expect(yield* observeOperationalEventMetrics({ db, now })).toEqual([
              { component: "platform-events", operation: "workerExceptions", state: "unavailable" },
              { component: "platform-events", operation: "resourceLimits", state: "unavailable" },
              {
                component: "platform-events",
                operation: "callbackRejections",
                state: "unavailable",
              },
              { component: "platform-events", operation: "workflowFailures", state: "unavailable" },
            ]);
            yield* Effect.tryPromise(() =>
              db.batch([
                db
                  .prepare("INSERT INTO operational_event_buckets VALUES ('heartbeat', ?, 1)")
                  .bind(now - 60_000),
                db
                  .prepare(
                    "INSERT INTO operational_event_buckets VALUES ('worker_exception', ?, 6)"
                  )
                  .bind(now - 60_000),
                db
                  .prepare("INSERT INTO operational_event_buckets VALUES ('resource_limit', ?, 1)")
                  .bind(now - 60_000),
                db
                  .prepare(
                    "INSERT INTO operational_event_buckets VALUES ('callback_rejection', ?, 22)"
                  )
                  .bind(now - 60_000),
              ])
            );
            expect(yield* observeOperationalEventMetrics({ db, now })).toEqual([
              {
                component: "platform-events",
                operation: "workerExceptions",
                state: "attention",
                recentCount: 6,
                fiveMinuteCount: 6,
              },
              {
                component: "platform-events",
                operation: "resourceLimits",
                state: "attention",
                recentCount: 1,
                fiveMinuteCount: 1,
              },
              {
                component: "platform-events",
                operation: "callbackRejections",
                state: "attention",
                recentCount: 22,
                fiveMinuteCount: 22,
              },
              {
                component: "platform-events",
                operation: "workflowFailures",
                state: "healthy",
                recentCount: 0,
                fiveMinuteCount: 0,
              },
            ]);
            yield* Effect.tryPromise(() =>
              db
                .prepare("INSERT INTO operational_event_buckets VALUES ('tail_overflow', ?, 1)")
                .bind(now)
                .run()
            );
            expect(
              (yield* observeOperationalEventMetrics({ db, now })).every(
                (metric) => metric.state === "unavailable"
              )
            ).toBe(true);
            yield* Effect.tryPromise(() =>
              db
                .prepare("INSERT INTO operational_event_buckets VALUES ('heartbeat', ?, 1)")
                .bind(0)
                .run()
            );
            yield* Effect.tryPromise(() =>
              db
                .prepare("INSERT INTO operational_event_buckets VALUES ('heartbeat', ?, 1)")
                .bind(172_800_000)
                .run()
            );
            yield* sweepOperationalEventBuckets({ db, now: 172_800_000 });
            expect(
              yield* Effect.tryPromise(() =>
                db
                  .prepare(
                    "SELECT count(*) AS count FROM operational_event_buckets WHERE bucket_ms = 0"
                  )
                  .first()
              )
            ).toEqual({ count: 0 });
            expect(
              yield* Effect.tryPromise(() =>
                db
                  .prepare(
                    "SELECT count(*) AS count FROM operational_event_buckets WHERE bucket_ms = ?"
                  )
                  .bind(172_800_000)
                  .first()
              )
            ).toEqual({ count: 1 });
          }),
        (instance) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
      )
    )
);
