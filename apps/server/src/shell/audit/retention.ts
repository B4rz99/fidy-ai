import { DateTime, Duration, Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import type { Telemetry } from "~/shell/observability/telemetry";
import { removeAuditLogEntriesBefore } from "./repo";

const auditRetentionDays = 365;
const auditRetentionDuration = Duration.days(auditRetentionDays);

/** Removes AuditLogEntry evidence strictly before the caller-supplied cutoff. */
export const runAuditRetentionBefore = (
  cutoff: DateTime.Utc
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  removeAuditLogEntriesBefore(cutoff);

export const runAuditRetention = (
  now: DateTime.Utc
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient> =>
  runAuditRetentionBefore(DateTime.subtractDuration(now, auditRetentionDuration));

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
