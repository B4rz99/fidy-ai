import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";

const warningAgeMs = 300000;

const criticalAgeMs = 600000;

const coverage = Schema.Struct({
  lastAttemptMs: Schema.NullOr(Schema.Int),
  lastObservedMs: Schema.NullOr(Schema.Int),
  oldest: Schema.NullOr(Schema.Int),
  started: Schema.Int,
  wrapped: Schema.Int,
});

const coverageSeverity = (age: number): string => {
  if (age < 0) return "unknown";

  if (age >= criticalAgeMs) return "critical";

  if (age >= warningAgeMs) return "warning";

  return "none";
};

export const watchdogCoverage = Effect.gen(function* () {
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;

  const [raw] =
    yield* sql`SELECT nullif(last_attempt_ms,0) AS lastAttemptMs,nullif(last_observed_ms,0) AS lastObservedMs,started_ms AS started,wrapped_at AS wrapped,
    (SELECT max(observed_ms,registered_ms) FROM lifetime_registry WHERE retired=0 ORDER BY max(observed_ms,registered_ms) LIMIT 1) AS oldest FROM watchdog_progress WHERE singleton=1`;

  const row = yield* Schema.decodeUnknownEffect(coverage)(raw);
  const oldest = row.oldest === 0 ? row.started : row.oldest;
  const traversal = row.wrapped || row.started;

  const coverageAgeMs =
    row.started === 0 ? null : Math.max(0, now - Math.min(oldest ?? traversal, traversal));

  return {
    coverageAgeMs,
    severity: coverageSeverity(coverageAgeMs ?? -1),
    lastAttemptMs: row.lastAttemptMs,
    lastObservedMs: row.lastObservedMs,
  };
});
