import { DateTime, Effect, Layer } from "effect";
import type { PersistedQueue } from "effect/unstable/persistence";
import type { WorkflowEngine } from "effect/unstable/workflow";
import { pruneConsentDisclosureDelivery } from "~/shell/channels/whatsapp/disclosure-retention";
import type { MessageStorage, Sharding } from "effect/unstable/cluster";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import {
  removeExpiredPendingConsentExchanges,
  removePendingConsentExchange,
} from "~/shell/consent/repo";
import {
  lockExpiredEmailEnrollmentsForRetention,
  removeExpiredEmailDeliveryBudgets,
  removeExpiredEmailEnrollment,
} from "~/shell/email-authentication/repo";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import { runBestEffortMaintenance } from "~/shell/maintenance-schedule";
import type { Telemetry } from "~/shell/observability/telemetry";
import { onboardingEmailDeliveryRetention } from "./delivery-workflow";

/** Removes expired pre-User onboarding state in one independently observed scheduled execution. */
export const runOnboardingRetention = (
  now: DateTime.Utc
): Effect.Effect<
  void,
  SqlError.SqlError,
  | MessageStorage.MessageStorage
  | Sharding.Sharding
  | SqlClient.SqlClient
  | Telemetry
  | WorkflowEngine.WorkflowEngine
  | PersistedQueue.PersistedQueueFactory
> =>
  runScheduledWork({
    component: "onboarding",
    schedule: "task.onboardingRetention",
    operationalError: "database_unavailable",
  })(
    Effect.gen(function* () {
      yield* pruneConsentDisclosureDelivery(now);
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const candidates = yield* lockExpiredEmailEnrollmentsForRetention(now);

          for (const candidate of candidates) {
            const durableExecutionsTerminal =
              yield* onboardingEmailDeliveryRetention.executionsTerminal(
                candidate.deliveryIntentIds,
                candidate.pendingDeliveryIntentIds
              );
            if (!durableExecutionsTerminal) continue;

            yield* Effect.forEach(
              candidate.deliveryIntentIds,
              onboardingEmailDeliveryRetention.clearWorkflowHistory,
              { discard: true }
            );
            yield* onboardingEmailDeliveryRetention.removeCompletedQueueItems(
              candidate.deliveryIntentIds
            );
            yield* removeExpiredEmailEnrollment(candidate.id, now);
            yield* removePendingConsentExchange(candidate.pendingConsentExchangeId);
          }

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
  runBestEffortMaintenance({
    timing: "best-effort",
    cadence: "1 hour",
    work: applyOnboardingRetention,
  }).pipe(Effect.forkScoped)
);
