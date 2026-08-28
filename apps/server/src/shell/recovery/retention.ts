import { DateTime, Effect, Layer, Schedule } from "effect";
import { runScheduledWork } from "~/shell/observability/scheduled-work";
import {
  deleteExpiredSupportRecoveryEvidence,
  expireDueSupportRecoveryCases,
  purgeSupportRecoveryAdmissionEvidence,
} from "./repo";

/** Closes one bounded batch and deletes one 24-month terminal-evidence batch. */
export const maintainSupportRecoveryEvidence = Effect.fn("Recovery.maintainEvidence")(function* () {
  const observedAt = yield* DateTime.now;
  yield* purgeSupportRecoveryAdmissionEvidence(observedAt);
  yield* expireDueSupportRecoveryCases(observedAt);
  yield* deleteExpiredSupportRecoveryEvidence(observedAt);
});

/** Runs one independently observed, bounded support-recovery retention execution. */
export const runScheduledSupportRecoveryRetention = runScheduledWork({
  component: "api",
  schedule: "task.supportRecoveryRetention",
  operationalError: "database_unavailable",
})(maintainSupportRecoveryEvidence());

const applyScheduledSupportRecoveryRetention = runScheduledSupportRecoveryRetention.pipe(
  Effect.ignoreCause
);

/** Production policy loop; every iteration is bounded and safe to repeat after interruption. */
export const SupportRecoveryRetentionLive = Layer.effectDiscard(
  applyScheduledSupportRecoveryRetention.pipe(
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped
  )
);
