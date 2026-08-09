import { DateTime, Duration, Effect, Layer, Schedule } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { removeAuditLogEntriesBefore } from "./repo";

const auditRetentionDays = 365;
const auditRetentionDuration = Duration.days(auditRetentionDays);

/**
 * Removes evidence strictly older than 365 days at one caller-supplied UTC instant.
 * Entries exactly at the cutoff remain.
 */
export const runAuditRetention = (
  now: DateTime.Utc
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  removeAuditLogEntriesBefore(DateTime.subtractDuration(now, auditRetentionDuration));

const runScheduledAuditRetention = Effect.gen(function* () {
  const now = yield* DateTime.now;
  yield* runAuditRetention(now);
  yield* Effect.logInfo("Applied AuditLogEntry retention");
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logError("AuditLogEntry retention failed; the next daily run will retry", cause)
  )
);

/**
 * Production retention worker. Cleanup runs immediately and once per day.
 * Database failures are reported and retried on the next run rather than
 * terminating the long-lived worker.
 */
export const AuditRetentionLive = Layer.effectDiscard(
  runScheduledAuditRetention.pipe(Effect.repeat(Schedule.spaced("1 day")), Effect.forkScoped)
);
