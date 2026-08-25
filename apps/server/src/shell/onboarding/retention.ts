import { DateTime, Effect, Layer, Schedule } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import {
  removeExpiredPendingConsentExchanges,
  removePendingConsentExchange,
} from "~/shell/consent/repo";
import {
  removeExpiredEmailDeliveryBudgets,
  removeExpiredEmailEnrollments,
} from "~/shell/email-authentication/repo";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import type { Telemetry } from "~/shell/observability/telemetry";

/** Removes expired pre-User onboarding state in one independently observed scheduled execution. */
export const runOnboardingRetention = (
  now: DateTime.Utc
): Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient | Telemetry> =>
  runScheduledWork({
    component: "onboarding",
    schedule: "task.onboardingRetention",
    operationalError: "database_unavailable",
  })(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const released = yield* removeExpiredEmailEnrollments(now);
          yield* Effect.forEach(
            released,
            ({ pendingConsentExchangeId }) =>
              removePendingConsentExchange(pendingConsentExchangeId),
            { discard: true }
          );
          yield* removeExpiredPendingConsentExchanges(now);
          yield* removeExpiredEmailDeliveryBudgets(now);
        })
      );
      yield* Effect.logInfo("Applied onboarding retention");
    })
  );

const applyOnboardingRetention = Effect.flatMap(DateTime.now, runOnboardingRetention).pipe(
  Effect.ignoreCause
);

/** Production retention worker. Cleanup runs immediately and once per hour; idle waits are unobserved. */
export const OnboardingRetentionLive = Layer.effectDiscard(
  applyOnboardingRetention.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped)
);
