import { Clock, Crypto, Effect, Option } from "effect";
import { UserId } from "../../src/core/identity/contract";
import type { EmailVerificationCode } from "@fidy/server/client";
import { prepareVerifiedUser } from "../identity/operations";
import { prepareOnboardingConsent } from "../consent/operations";
import { prepareOnboardingCredential } from "../email-authentication/operations";
import { prepareInitialBackupRecoveryCode } from "../recovery/operations";
import { prepareInitialTrialPeriod } from "../subscription/operations";
import type { OnboardingCompletion } from "./contract";

/**
 * Complete verified onboarding once. Owner-prepared User, WhatsApp association, verified mailbox,
 * accepted Consent, original TrialPeriod, and recovery authority commit with proof consumption in
 * one D1 unit. A conflict or replay creates no partial User and discloses no recovery credential.
 * This coordinator owns no persisted facts and performs no financial processing.
 */
export const completeOnboarding = ({
  db,
  combinedCode,
}: {
  readonly db: D1Database;
  readonly combinedCode: EmailVerificationCode;
}): Effect.Effect<OnboardingCompletion, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const prepared = yield* prepareOnboardingCredential({ db, combinedCode, nowMs: now });
    if (Option.isNone(prepared)) return { _tag: "Invalid" } as const;
    const cryptoService = yield* Crypto.Crypto;
    const userId = UserId.make(yield* cryptoService.randomUUIDv4);
    const identity = prepareVerifiedUser({
      db,
      userId,
      exchangeId: prepared.value.pendingConsentExchangeId,
      now,
    });
    const recovery = yield* Effect.tryPromise({
      try: () => prepareInitialBackupRecoveryCode({ db, userId, createdAtMs: now }),
      catch: () => undefined,
    });
    const [credential, completion] = prepared.value.statements({ userId, verifiedAtMs: now });
    yield* Effect.tryPromise({
      try: () =>
        db.batch([
          identity.user,
          identity.association,
          credential,
          prepareOnboardingConsent({
            db,
            userId,
            exchangeId: prepared.value.pendingConsentExchangeId,
          }),
          prepareInitialTrialPeriod({ db, userId, verifiedAtMs: now }),
          recovery.statement,
          completion,
        ]),
      catch: () => undefined,
    });
    return { _tag: "Created", backupRecoveryCode: recovery.backupRecoveryCode } as const;
  }).pipe(
    Effect.catchTag("OnboardingProofUnavailable", () =>
      Effect.succeed<OnboardingCompletion>({ _tag: "Unavailable" })
    ),
    Effect.catchCause(() => Effect.succeed<OnboardingCompletion>({ _tag: "Invalid" }))
  );
