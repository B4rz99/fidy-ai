import { Config, Crypto, DateTime, Effect, Layer, Option } from "effect";
import { EmailDeliveryClaimToken } from "~/core/email-authentication/model";
import { sendEmailWithBoundedRetry } from "~/shell/email-authentication/delivery-retry";
import {
  claimAndArmEmailDeliveryIntent,
  reconcileExpiredArmedClaims,
  settleEmailDelivery,
} from "~/shell/email-authentication/repo";

/** Time reserved for one worker to finish all retries before another may recover the delivery. */
const deliveryClaimLeaseSeconds = 60;

/** Processes at most one intent, keeping the raw proof inside this worker turn only. */
export const processOneOnboardingDelivery = Effect.fn("OnboardingDelivery.processOne")(
  function* () {
    const reconciliationTime = yield* DateTime.now;
    yield* reconcileExpiredArmedClaims(reconciliationTime);
    const crypto = yield* Crypto.Crypto;
    const claimToken = EmailDeliveryClaimToken.make(yield* crypto.randomUUIDv7.pipe(Effect.orDie));
    const claimedAt = yield* DateTime.now;
    const claimed = yield* claimAndArmEmailDeliveryIntent({
      claimToken,
      claimedAt,
      claimExpiresAt: DateTime.add(claimedAt, { seconds: deliveryClaimLeaseSeconds }),
    });
    if (Option.isNone(claimed)) return false;

    const intent = claimed.value;
    const deliveryStatus = yield* sendEmailWithBoundedRetry({
      purpose: "verified-onboarding",
      to: intent.email,
      combinedCode: intent.combinedCode,
      idempotencyKey: intent.idempotencyKey,
    }).pipe(
      Effect.withSpan("emailAuthentication.deliverVerification", {
        attributes: { "fidy.email.delivery_generation": intent.generation },
      })
    );
    yield* settleEmailDelivery({
      intent,
      status: deliveryStatus,
      providerMessageId: Option.none(),
    });
    return true;
  }
);

export const OnboardingDeliveryWorkerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    yield* processOneOnboardingDelivery().pipe(
      Effect.delay("1 second"),
      Effect.forever,
      Effect.forkScoped
    );
  })
);
