import { DateTime, Deferred, Effect } from "effect";
import { ConsentRecord, type ConsentRecordId } from "~/core/consent/model";
import type { UserId } from "~/core/identity/reference";
import {
  appendConsentRecord,
  appendConsentRecordInScope,
  observeConsentRecords,
  withSubjectLock,
} from "~/shell/consent/repo";
import { withConsentExternalEffectLock } from "~/shell/db/advisory-lock";

/** Copies a current fixture onboarding grant onto another stable test User. */
export const grantCurrentOnboardingConsentForTesting = Effect.fn(
  "Testing.grantCurrentOnboardingConsent"
)(function* (input: {
  readonly sourceUserId: UserId;
  readonly subjectUserId: UserId;
  readonly grantId: ConsentRecordId;
}) {
  const grant = (yield* observeConsentRecords(input.sourceUserId)).findLast(
    (record) => record.event._tag === "Granted" && record.event.grant._tag === "Onboarding"
  );
  if (grant === undefined) return yield* Effect.die("missing source fixture Consent grant");
  if (grant.evidence._tag !== "ProviderQualifiedMessages") {
    return yield* Effect.die(
      "source fixture Consent grant did not use provider-qualified evidence"
    );
  }
  yield* appendConsentRecord(
    ConsentRecord.make({
      ...grant,
      id: input.grantId,
      subjectUserId: input.subjectUserId,
      evidence: {
        ...grant.evidence,
        decisionMessage: {
          channel: "development",
          provider: "test",
          providerMessageId: `test-consent-grant:${input.grantId}`,
        },
      },
    })
  );
});

const currentOnboardingRevocationForTesting = Effect.fn("Testing.currentOnboardingRevocation")(
  function* (userId: UserId, revocationId: ConsentRecordId) {
    const grant = (yield* observeConsentRecords(userId)).findLast(
      (record) => record.event._tag === "Granted" && record.event.grant._tag === "Onboarding"
    );
    if (grant === undefined) return yield* Effect.die("missing fixture Consent grant");
    if (grant.evidence._tag !== "ProviderQualifiedMessages") {
      return yield* Effect.die("fixture Consent grant did not use provider-qualified evidence");
    }
    return ConsentRecord.make({
      ...grant,
      id: revocationId,
      event: { _tag: "Revoked", grantId: grant.id },
      occurredAt: DateTime.add(grant.occurredAt, { milliseconds: 1 }),
      evidence: {
        ...grant.evidence,
        decisionMessage: {
          channel: "development",
          provider: "test",
          providerMessageId: `test-consent-revocation:${revocationId}`,
        },
      },
    });
  }
);

/** Leaves a complete stable User while making current onboarding Consent unavailable in tests. */
export const revokeCurrentOnboardingConsentForTesting = Effect.fn(
  "Testing.revokeCurrentOnboardingConsent"
)(function* (userId: UserId, revocationId: ConsentRecordId) {
  yield* appendConsentRecord(yield* currentOnboardingRevocationForTesting(userId, revocationId));
});

/** Deterministic barrier for proving revocation-first external-effect ordering with PostgreSQL. */
export const revokeCurrentOnboardingConsentAtGateForTesting = Effect.fn(
  "Testing.revokeCurrentOnboardingConsentAtGate"
)(function* (input: {
  readonly userId: UserId;
  readonly revocationId: ConsentRecordId;
  readonly gateAcquired: Deferred.Deferred<void>;
  readonly releaseRevocation: Deferred.Deferred<void>;
}) {
  const record = yield* currentOnboardingRevocationForTesting(input.userId, input.revocationId);
  yield* withConsentExternalEffectLock(
    input.userId,
    Deferred.succeed(input.gateAcquired, undefined).pipe(
      Effect.andThen(Deferred.await(input.releaseRevocation)),
      Effect.andThen(withSubjectLock(input.userId, appendConsentRecordInScope(record)))
    )
  );
});
