import { DateTime, Effect, Layer, Schedule } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import type { Telemetry } from "~/shell/observability/telemetry";
import { removeExpiredPendingConsentExchanges } from "./repo";

/** Removes expired pending Consent exchanges in one independently observed scheduled execution. */
export const runPendingConsentRetention = (
  now: DateTime.Utc
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient | Telemetry> =>
  runScheduledWork({
    component: "whatsapp",
    schedule: "task.pendingConsentRetention",
    operationalError: "database_unavailable",
  })(
    removeExpiredPendingConsentExchanges(now).pipe(
      Effect.tap(() => Effect.logInfo("Applied pending Consent retention"))
    )
  );

const applyPendingRetention = Effect.flatMap(DateTime.now, runPendingConsentRetention).pipe(
  Effect.ignoreCause
);

/** Production retention worker. Cleanup runs immediately and once per hour; idle waits are unobserved. */
export const PendingConsentRetentionLive = Layer.effectDiscard(
  applyPendingRetention.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped)
);
