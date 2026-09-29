import { Miniflare } from "miniflare";
import { it } from "@effect/vitest";
import { type Cause, Effect } from "effect";
import { expect } from "vitest";
import {
  observeOperationalEventMetrics,
  sweepOperationalEventBuckets,
} from "./operational-event-metrics";

const makeDatabase = (): Effect.Effect<
  Readonly<{ instance: Miniflare; db: D1Database }>,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    const instance = new Miniflare({
      workers: [
        {
          config: {
            name: "workflow-metrics",
            type: "worker",
            compatibilityDate: "2026-09-08",
            env: { DB: { id: "workflow-metrics", type: "d1" } },
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
    });
    yield* Effect.tryPromise(() => instance.ready);
    const db = yield* Effect.tryPromise(() => instance.getD1Database("DB"));
    return { instance, db };
  });

it.effect("measures Workflow failures without requiring paid Tail Worker telemetry", () =>
  Effect.scoped(
    Effect.acquireUseRelease(
      makeDatabase(),
      ({ db }) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "CREATE TABLE operational_event_buckets (kind TEXT NOT NULL, bucket_ms INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, bucket_ms))"
              )
              .run()
          );
          const now = 1_800_000;
          expect(yield* observeOperationalEventMetrics({ db, now })).toEqual([
            {
              component: "workflow-execution",
              operation: "workflowFailures",
              state: "healthy",
              recentCount: 0,
              fiveMinuteCount: 0,
            },
          ]);
          yield* Effect.tryPromise(() =>
            db.batch([
              db
                .prepare("INSERT INTO operational_event_buckets VALUES ('heartbeat', ?, 1)")
                .bind(now),
              db
                .prepare("INSERT INTO operational_event_buckets VALUES ('worker_exception', ?, 12)")
                .bind(now),
              db
                .prepare("INSERT INTO operational_event_buckets VALUES ('workflow_failure', ?, 6)")
                .bind(now - 60_000),
              db
                .prepare("INSERT INTO operational_event_buckets VALUES ('workflow_failure', ?, 4)")
                .bind(now - 600_000),
            ])
          );
          expect(yield* observeOperationalEventMetrics({ db, now })).toEqual([
            {
              component: "workflow-execution",
              operation: "workflowFailures",
              state: "attention",
              recentCount: 10,
              fiveMinuteCount: 6,
            },
          ]);
          yield* Effect.tryPromise(() =>
            db
              .prepare("INSERT INTO operational_event_buckets VALUES ('workflow_failure', ?, 1)")
              .bind(0)
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
        }),
      ({ instance }) => Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
    )
  )
);

it.effect("reports Workflow failure monitoring unavailable when its D1 inspection fails", () =>
  Effect.gen(function* () {
    const { instance, db } = yield* makeDatabase();
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => instance.dispose()).pipe(Effect.orDie)
    );
    expect(yield* observeOperationalEventMetrics({ db, now: 1_800_000 })).toEqual([
      { component: "workflow-execution", operation: "workflowFailures", state: "unavailable" },
    ]);
  })
);
