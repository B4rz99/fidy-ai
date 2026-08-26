import { DateTime, Duration, Effect, Layer, Schedule } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { runAuditRetentionBefore } from "~/shell/audit/retention";
import { removeLifecycleEventsBefore } from "~/shell/email-authentication/replacement-repo";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import type { Telemetry } from "~/shell/observability/telemetry";

const retainedEvidenceDays = 365;
const retainedEvidenceLifetime = Duration.days(retainedEvidenceDays);

const deleteAuditEvidenceBefore = (
  cutoff: DateTime.Utc
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient | Telemetry> =>
  runAuditRetentionBefore(cutoff).pipe(
    runScheduledWork({
      component: "api",
      schedule: "task.auditRetention",
      operationalError: "database_unavailable",
    })
  );

const deleteEmailAuthenticationEvidenceBefore = (
  cutoff: DateTime.Utc
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient | Telemetry> =>
  removeLifecycleEventsBefore(cutoff).pipe(
    runScheduledWork({
      component: "api",
      schedule: "task.emailAuthenticationRetention",
      operationalError: "database_unavailable",
    })
  );

/**
 * Applies owner-specific evidence retention independently from one strict 365-day cutoff. A
 * database failure in either owner is observed without preventing the other owner's execution.
 */
export const runEvidenceRetention = (
  now: DateTime.Utc
): Effect.Effect<void, never, SqlClient.SqlClient | Telemetry> => {
  const cutoff = DateTime.subtractDuration(now, retainedEvidenceLifetime);
  return Effect.all(
    [
      deleteAuditEvidenceBefore(cutoff).pipe(Effect.ignore),
      deleteEmailAuthenticationEvidenceBefore(cutoff).pipe(Effect.ignore),
    ],
    { concurrency: "unbounded", discard: true }
  );
};

const applyEvidenceRetention = Effect.flatMap(DateTime.now, runEvidenceRetention);

/** Shell-owned daily scheduler; Audit and EmailAuthentication retain separate persistence calls. */
export const EvidenceRetentionLive = Layer.effectDiscard(
  applyEvidenceRetention.pipe(Effect.repeat(Schedule.spaced("1 day")), Effect.forkScoped)
);
