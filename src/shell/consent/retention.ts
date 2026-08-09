import { DateTime, Effect, Layer, Schedule } from "effect";
import { removeExpiredPendingConsentExchanges } from "./repo";

const applyPendingRetention = Effect.gen(function* () {
  const now = yield* DateTime.now;
  yield* removeExpiredPendingConsentExchanges(now);
  yield* Effect.logInfo("Applied pending Consent retention");
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logError("Pending Consent retention failed; the next hourly run will retry", cause)
  )
);

/** Production retention worker. Cleanup runs immediately and once per hour. */
export const PendingConsentRetentionLive = Layer.effectDiscard(
  applyPendingRetention.pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.forkScoped)
);
