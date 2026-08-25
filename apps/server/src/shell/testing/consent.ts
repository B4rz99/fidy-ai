import { DateTime, Effect } from "effect";
import { ConsentRecord, type ConsentRecordId } from "~/core/consent/model";
import type { UserId } from "~/core/identity/reference";
import { appendConsentRecord, observeConsentRecords } from "~/shell/consent/repo";

/** Leaves a complete stable User while making current onboarding Consent unavailable in tests. */
export const revokeCurrentOnboardingConsentForTesting = Effect.fn(
  "Testing.revokeCurrentOnboardingConsent"
)(function* (userId: UserId, revocationId: ConsentRecordId) {
  const grant = (yield* observeConsentRecords(userId)).findLast(
    (record) => record.event._tag === "Granted" && record.event.grant._tag === "Onboarding"
  );
  if (grant === undefined) return yield* Effect.die("missing fixture Consent grant");
  if (grant.evidence._tag !== "ProviderQualifiedMessages") {
    return yield* Effect.die("fixture Consent grant did not use provider-qualified evidence");
  }
  yield* appendConsentRecord(
    ConsentRecord.make({
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
    })
  );
});
