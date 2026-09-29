import { Effect, Exit, Schema } from "effect";

const WorkflowFailureCounts = Schema.Struct({
  recentCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  fiveMinuteCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const minuteMs = 60_000;
const recentWindowMinutes = 15;
const freshWindowMinutes = 5;
const recentWindowMs = recentWindowMinutes * minuteMs;
const fiveMinuteWindowMs = freshWindowMinutes * minuteMs;
const bucketRetentionMs = 86_400_000;
const maximumSweepRows = 128;

/** Bounded expiry prevents operational event buckets from growing indefinitely. */
export const sweepOperationalEventBuckets = ({
  db,
  now,
}: Readonly<{
  db: D1Database;
  now: number;
}>): Effect.Effect<void, void> =>
  Effect.tryPromise(() =>
    db
      .prepare(`DELETE FROM operational_event_buckets
  WHERE rowid IN (SELECT rowid FROM operational_event_buckets WHERE bucket_ms < ? LIMIT ?)`)
      .bind(now - bucketRetentionMs, maximumSweepRows)
      .run()
  ).pipe(
    Effect.timeout("2 seconds"),
    Effect.asVoid,
    Effect.mapError(() => undefined)
  );

export type EventMetricSignal = Readonly<{
  component: "workflow-execution";
  operation: "workflowFailures";
}> &
  (
    | Readonly<{ state: "unavailable" }>
    | Readonly<{ state: "healthy" | "attention"; recentCount: number; fiveMinuteCount: number }>
  );

const unavailableMetrics = (): ReadonlyArray<EventMetricSignal> => [
  { component: "workflow-execution", operation: "workflowFailures", state: "unavailable" },
];

/** Inspects directly recorded Workflow failures; an unreadable D1 measurement is unavailable. */
export const observeOperationalEventMetrics = ({
  db,
  now,
}: Readonly<{
  db: D1Database;
  now: number;
}>): Effect.Effect<ReadonlyArray<EventMetricSignal>> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Effect.tryPromise(() =>
        db
          .prepare(`SELECT
        COALESCE(SUM(count), 0) AS recentCount,
        COALESCE(SUM(CASE WHEN bucket_ms >= ? THEN count ELSE 0 END), 0) AS fiveMinuteCount
        FROM operational_event_buckets
        WHERE kind = 'workflow_failure' AND bucket_ms >= ? AND bucket_ms <= ?`)
          .bind(now - fiveMinuteWindowMs, now - recentWindowMs, now)
          .first()
      ).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap((row) => Schema.decodeUnknownEffect(WorkflowFailureCounts)(row))
      )
    );
    if (Exit.isFailure(result)) return unavailableMetrics();
    const { recentCount, fiveMinuteCount } = result.value;
    return [
      {
        component: "workflow-execution",
        operation: "workflowFailures",
        state: recentCount > 0 ? "attention" : "healthy",
        recentCount,
        fiveMinuteCount,
      },
    ];
  });
