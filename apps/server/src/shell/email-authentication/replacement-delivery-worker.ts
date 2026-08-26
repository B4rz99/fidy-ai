import { Config, DateTime, Effect, Layer, Option, Schedule } from "effect";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { withSubjectLock } from "~/shell/consent/repo";
import { sendEmailWithBoundedRetry } from "./delivery-retry";
import {
  armClaimedReplacementInScope,
  claimExpiredReplacementWorkflow,
  claimReplacementDeliveryGateway,
  removeClaimedExpiredReplacementWorkflowInScope,
  settleReplacementDeliveryInScope,
} from "./replacement-repo";

/** Processes at most one replacement delivery without holding a transaction over provider I/O. */
export const processOneReplacementDelivery = Effect.fn("EmailReplacementDelivery.processOne")(
  function* () {
    const claimedAt = yield* DateTime.now;
    const gatewayClaim = yield* claimReplacementDeliveryGateway(claimedAt);
    if (Option.isNone(gatewayClaim)) return false;
    const claim = gatewayClaim.value;
    const armed = yield* withUserTransaction(
      claim.userId,
      withSubjectLock(claim.userId, armClaimedReplacementInScope(claim, claimedAt))
    );
    if (Option.isNone(armed)) return false;
    const intent = armed.value;
    const status = yield* sendEmailWithBoundedRetry({
      purpose: "credential-replacement",
      to: intent.emailAddress,
      combinedCode: intent.combinedCode,
      idempotencyKey: intent.idempotencyKey,
    });
    yield* withUserTransaction(
      claim.userId,
      withSubjectLock(
        claim.userId,
        settleReplacementDeliveryInScope({
          claim: intent,
          status,
          providerMessageId: Option.none(),
        })
      )
    );
    return true;
  }
);

/** Deletes at most one leased expired workflow after re-entering its User scope and subject lock. */
export const processOneReplacementRetention = Effect.fn("EmailReplacementRetention.processOne")(
  function* () {
    const attemptedAt = yield* DateTime.now;
    const gatewayClaim = yield* claimExpiredReplacementWorkflow(attemptedAt);
    if (Option.isNone(gatewayClaim)) return false;
    const claim = gatewayClaim.value;
    return yield* withUserTransaction(
      claim.userId,
      withSubjectLock(
        claim.userId,
        removeClaimedExpiredReplacementWorkflowInScope(claim, attemptedAt)
      )
    );
  }
);

/** Production proof delivery loop; provider calls remain outside database transactions. */
export const EmailReplacementDeliveryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    yield* processOneReplacementDelivery().pipe(
      Effect.delay("1 second"),
      Effect.forever,
      Effect.forkScoped
    );
  })
);

/** Expired-workflow cleanup runs immediately and once per minute through its lease gateway. */
export const EmailReplacementRetentionLive = Layer.effectDiscard(
  processOneReplacementRetention().pipe(
    Effect.ignoreCause,
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped
  )
);
