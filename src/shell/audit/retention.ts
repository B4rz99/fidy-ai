import { DateTime, Duration, Effect, Layer, Schedule } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import type { Telemetry } from "~/shell/observability/telemetry";
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

/** Runs one independently observed AuditLogEntry retention execution at the supplied UTC instant. */
export const runScheduledAuditRetention = (
  now: DateTime.Utc
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient | Telemetry> =>
  runScheduledWork({
    component: "api",
    schedule: "task.auditRetention",
    operationalError: "database_unavailable",
  })(
    runAuditRetention(now).pipe(Effect.tap(() => Effect.logInfo("Applied AuditLogEntry retention")))
  );

const applyScheduledAuditRetention = Effect.flatMap(DateTime.now, runScheduledAuditRetention).pipe(
  Effect.ignoreCause
);

/**
 * Production retention worker. Cleanup runs immediately and once per day. Database failures are
 * captured at scheduled-work ownership and retried on the next run without stopping the worker.
 */
export const AuditRetentionLive = Layer.effectDiscard(
  applyScheduledAuditRetention.pipe(Effect.repeat(Schedule.spaced("1 day")), Effect.forkScoped)
);
