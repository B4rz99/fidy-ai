import { Effect, Exit, Schema } from "effect";

const EventBucket = Schema.Struct({
  kind: Schema.Literals([
    "heartbeat",
    "tail_overflow",
    "worker_exception",
    "resource_limit",
    "callback_rejection",
    "workflow_failure",
  ]),
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  five: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  newest: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const minuteMs = 60_000;
const recentWindowMinutes = 15;
const freshWindowMinutes = 5;
const recentWindowMs = recentWindowMinutes * minuteMs;
const fiveMinuteWindowMs = freshWindowMinutes * minuteMs;

export type EventMetricSignal = Readonly<{
  component: "platform-events";
  operation: "workerExceptions" | "resourceLimits" | "callbackRejections" | "workflowFailures";
}> &
  (
    | Readonly<{ state: "unavailable" }>
    | Readonly<{ state: "healthy" | "attention"; recentCount: number; fiveMinuteCount: number }>
  );

const dimensions = [
  { kind: "worker_exception", operation: "workerExceptions", threshold: 5 },
  { kind: "resource_limit", operation: "resourceLimits", threshold: 1 },
  { kind: "callback_rejection", operation: "callbackRejections", threshold: 5 },
  { kind: "workflow_failure", operation: "workflowFailures", threshold: 1 },
] as const;

const unavailableMetrics = (): ReadonlyArray<EventMetricSignal> =>
  dimensions.map((dimension) => ({
    component: "platform-events",
    operation: dimension.operation,
    state: "unavailable",
  }));

/** Aggregate platform tails by finite kind; missing or stale heartbeat is unavailable, never zero. */
export const observeOperationalEventMetrics = (
  db: D1Database,
  now: number
): Effect.Effect<ReadonlyArray<EventMetricSignal>> =>
  Effect.gen(function* () {
    const rows = yield* Effect.exit(
      Effect.tryPromise(() =>
        db
          .prepare(`SELECT kind, SUM(count) AS count,
        SUM(CASE WHEN bucket_ms >= ? THEN count ELSE 0 END) AS five,
        MAX(bucket_ms) AS newest
        FROM operational_event_buckets WHERE bucket_ms >= ? AND bucket_ms <= ? GROUP BY kind`)
          .bind(now - fiveMinuteWindowMs, now - recentWindowMs, now)
          .all()
      ).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap((result) =>
          Schema.decodeUnknownEffect(Schema.Array(EventBucket))(result.results)
        )
      )
    );
    if (Exit.isFailure(rows)) return unavailableMetrics();
    const heartbeat = rows.value.find((row) => row.kind === "heartbeat");
    if (
      heartbeat === undefined ||
      heartbeat.newest < now - fiveMinuteWindowMs ||
      rows.value.some((row) => row.kind === "tail_overflow")
    ) {
      return unavailableMetrics();
    }
    return dimensions.map((dimension): EventMetricSignal => {
      const count = rows.value.find((row) => row.kind === dimension.kind);
      const recentCount = count?.count ?? 0;
      return {
        component: "platform-events",
        operation: dimension.operation,
        state: recentCount >= dimension.threshold ? "attention" : "healthy",
        recentCount,
        fiveMinuteCount: count?.five ?? 0,
      };
    });
  });
