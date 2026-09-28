import { Miniflare } from "miniflare";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  observeOperationalEventMetrics,
  sweepOperationalEventBuckets,
} from "./operational-event-metrics";

it("reports missing tail telemetry as unavailable instead of zero and classifies recent bounded counts", async () => {
  const instance = new Miniflare({
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
  });
  try {
    await instance.ready;
    const db = await instance.getD1Database("DB");
    await db
      .prepare(
        "CREATE TABLE operational_event_buckets (kind TEXT NOT NULL, bucket_ms INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (kind, bucket_ms))"
      )
      .run();
    const now = 1_800_000;
    expect(await Effect.runPromise(observeOperationalEventMetrics(db, now))).toEqual([
      { component: "platform-events", operation: "workerExceptions", state: "unavailable" },
      { component: "platform-events", operation: "resourceLimits", state: "unavailable" },
      { component: "platform-events", operation: "callbackRejections", state: "unavailable" },
      { component: "platform-events", operation: "workflowFailures", state: "unavailable" },
    ]);
    await db.batch([
      db
        .prepare("INSERT INTO operational_event_buckets VALUES ('heartbeat', ?, 1)")
        .bind(now - 60_000),
      db
        .prepare("INSERT INTO operational_event_buckets VALUES ('worker_exception', ?, 6)")
        .bind(now - 60_000),
      db
        .prepare("INSERT INTO operational_event_buckets VALUES ('resource_limit', ?, 1)")
        .bind(now - 60_000),
      db
        .prepare("INSERT INTO operational_event_buckets VALUES ('callback_rejection', ?, 22)")
        .bind(now - 60_000),
    ]);
    expect(await Effect.runPromise(observeOperationalEventMetrics(db, now))).toEqual([
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
    await db
      .prepare("INSERT INTO operational_event_buckets VALUES ('tail_overflow', ?, 1)")
      .bind(now)
      .run();
    expect(
      (await Effect.runPromise(observeOperationalEventMetrics(db, now))).every(
        (metric) => metric.state === "unavailable"
      )
    ).toBe(true);
    await db
      .prepare("INSERT INTO operational_event_buckets VALUES ('heartbeat', ?, 1)")
      .bind(0)
      .run();
    await db
      .prepare("INSERT INTO operational_event_buckets VALUES ('heartbeat', ?, 1)")
      .bind(172_800_000)
      .run();
    await Effect.runPromise(sweepOperationalEventBuckets(db, 172_800_000));
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM operational_event_buckets WHERE bucket_ms = 0")
        .first()
    ).toEqual({ count: 0 });
    expect(
      await db
        .prepare("SELECT count(*) AS count FROM operational_event_buckets WHERE bucket_ms = ?")
        .bind(172_800_000)
        .first()
    ).toEqual({ count: 1 });
  } finally {
    await instance.dispose();
  }
});
