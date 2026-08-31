import { UnknownJsonString } from "~/schema-compatibility";
import { Crypto, Data, DateTime, Effect, Encoding, Option, Result, Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import {
  RawEmailIngestSample,
  ReceivedEmailContent,
  type ReceivedEmailContent as ReceivedEmailContentType,
} from "~/core/ingestion/model";
import {
  type ForwardedEmailProviderFailureReason,
  decideForwardedEmailRecovery,
  redactEmailCandidate,
} from "~/core/ingestion/rules";
import { IngestSampleId, NeedsReviewItemId } from "~/core/ingestion/reference";
import {
  TransactionExtraction,
  type TransactionExtraction as TransactionExtractionType,
} from "~/core/transactions/model";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { freePatCaller } from "~/shell/_shared/suggested-operations";
import { hasCurrentOnboardingConsent, withSubjectLock } from "~/shell/consent/repo";
import { withConsentExternalEffectLock } from "~/shell/db/advisory-lock";
import { captureNotificationEmailTransactionInScope } from "~/shell/transactions/mutations";
import { normalizedMailbox } from "./email-address";
import {
  NotificationEmailExtractor,
  withNotificationEmailExtractionDeadline,
} from "./email-extractor";
import { emailIngestRetentionDays } from "./email-retention";
import {
  type ClaimedForwardedEmail,
  claimForwardedEmail,
  completeForwardedEmailWithReviewInScope,
  completeForwardedEmailWithTransactionInScope,
  deferForwardedEmailClaimForConsent,
  insertRawEmailSampleInScope,
  ownsForwardedEmailClaimInScope,
  retryForwardedEmailClaim,
} from "./email-forwarding-repo";
import { ResendReceivingClient, type ResendReceivingFailed } from "./resend-receiving-client";

class ConsentRevokedDuringEmailProcessing extends Data.TaggedError(
  "ConsentRevokedDuringEmailProcessing"
)<{}> {}

/** Durable revision attached to model-derived notification-email interpretations. */
export const notificationEmailExtractorRevision = "notification-email-extractor-v1";
/** Durable revision attached to automatic value-free redaction candidates. */
export const notificationEmailAnonymizationRevision = "email-redaction-candidate-v1";

const encodeReceivedEmailContent = Effect.fn("encodeReceivedEmailContent")(function* (
  content: ReceivedEmailContentType
) {
  const encoded = yield* Schema.encodeEffect(ReceivedEmailContent)(content);
  return yield* Schema.encodeEffect(UnknownJsonString)(encoded);
});

const candidateContent = (content: ReceivedEmailContentType): string =>
  [
    content.subject,
    Option.getOrElse(content.text, () => ""),
    Option.getOrElse(content.html, () => ""),
  ].join("\n");

type ReviewInput = Readonly<{
  claimed: ClaimedForwardedEmail;
  sampleId: IngestSampleId;
  reason: "model-unavailable" | "canonical-validation-failed";
  extraction: Option.Option<TransactionExtraction>;
}>;

const createReview = Effect.fnUntraced(function* (input: ReviewInput) {
  const crypto = yield* Crypto.Crypto;
  yield* completeForwardedEmailWithReviewInScope({
    claimed: input.claimed,
    reviewId: NeedsReviewItemId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
    evidence: {
      _tag: "RawSample",
      sampleId: input.sampleId,
      reason: input.reason,
      extraction: input.extraction,
    },
    extractorRevision: notificationEmailExtractorRevision,
    issues: [
      {
        path: "",
        message:
          input.reason === "model-unavailable"
            ? "The notification email could not be interpreted after bounded model attempts."
            : "The interpreted email could not be captured as a canonical Transaction.",
      },
    ],
    createdAt: yield* DateTime.now,
  });
});

const finalizeExtraction = Effect.fn("finalizeNotificationEmailExtraction")(function* (input: {
  claimed: ClaimedForwardedEmail;
  sampleId: IngestSampleId;
  contentHash: string;
  extraction: TransactionExtractionType;
}) {
  const { claimed, sampleId, contentHash, extraction } = input;
  const decoded = Schema.encodeUnknownResult(TransactionExtraction)(extraction);
  if (Result.isFailure(decoded)) {
    if (!(yield* ownsForwardedEmailClaimInScope(claimed))) return;
    yield* createReview({
      claimed,
      sampleId,
      reason: "canonical-validation-failed",
      extraction: Option.none(),
    });
    return;
  }
  if (!(yield* ownsForwardedEmailClaimInScope(claimed))) return;
  const captured = yield* Effect.result(
    captureNotificationEmailTransactionInScope({
      userId: claimed.userId,
      caller: freePatCaller(["write"]),
      extraction,
      context: {
        serviceMarket: claimed.serviceMarket,
        locale: claimed.locale,
        timeZone: claimed.timeZone,
      },
      attestation: {
        receivedEmailId: claimed.receivedEmailId,
        messageEvidence: {
          channel: "email",
          provider: "resend",
          providerMessageId: claimed.receivedEmailId,
        },
        messageContentSha256: contentHash,
        sourceFormat: "notification-email",
        parserRevision: InterpretationRevision.make(claimed.parserRevision),
        extractorRevision: InterpretationRevision.make(notificationEmailExtractorRevision),
      },
    })
  );
  if (Result.isFailure(captured)) {
    yield* createReview({
      claimed,
      sampleId,
      reason: "canonical-validation-failed",
      extraction: Option.some(extraction),
    });
    return;
  }
  yield* completeForwardedEmailWithTransactionInScope(
    claimed,
    captured.success.id,
    yield* DateTime.now
  );
});

const deferForMissingConsent = (
  claimed: ClaimedForwardedEmail
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.flatMap(DateTime.now, (now) =>
    deferForwardedEmailClaimForConsent(claimed, DateTime.add(now, { days: 1 }))
  );

const useCurrentConsentOrDefer = Effect.fn("useCurrentConsentOrDeferForwardedEmail")(function* <
  A,
  E,
  R,
>(claimed: ClaimedForwardedEmail, use: Effect.Effect<A, E, R>) {
  return yield* withSubjectLock(
    claimed.userId,
    Effect.gen(function* () {
      if (!(yield* hasCurrentOnboardingConsent(claimed.userId))) {
        yield* deferForMissingConsent(claimed);
        return Option.none<A>();
      }
      return Option.some(yield* use);
    })
  );
});

/**
 * Starts one bounded external effect while holding the same session gate as Consent revocation.
 * The Consent transaction commits before `use` starts; no transaction spans provider/model I/O.
 */
const useCurrentConsentForExternalEffect = Effect.fn(
  "useCurrentConsentForForwardedEmailExternalEffect"
)(function* <A, E, R>(claimed: ClaimedForwardedEmail, use: Effect.Effect<A, E, R>) {
  return yield* withConsentExternalEffectLock(
    claimed.userId,
    Effect.gen(function* () {
      const armed = yield* withSubjectLock(
        claimed.userId,
        Effect.gen(function* () {
          if (yield* hasCurrentOnboardingConsent(claimed.userId)) return true;
          yield* deferForwardedEmailClaimForConsent(
            claimed,
            DateTime.add(yield* DateTime.now, { days: 1 })
          );
          return false;
        })
      );
      if (!armed) return yield* new ConsentRevokedDuringEmailProcessing();
      return yield* use;
    })
  );
});

const recoverProviderFailure = Effect.fn("recoverForwardedEmailProviderFailure")(function* (
  claimed: ClaimedForwardedEmail,
  reason: ForwardedEmailProviderFailureReason
) {
  const decision = decideForwardedEmailRecovery({
    reason,
    attemptCount: claimed.attemptCount,
  });
  const recovery =
    decision._tag === "Retry"
      ? retryForwardedEmailClaim(claimed)
      : Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          yield* completeForwardedEmailWithReviewInScope({
            claimed,
            reviewId: NeedsReviewItemId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
            evidence: {
              _tag: "ProviderMessage",
              reason: decision.reviewReason,
            },
            extractorRevision: notificationEmailExtractorRevision,
            issues: [decision.issue],
            createdAt: yield* DateTime.now,
          });
        });
  yield* useCurrentConsentOrDefer(claimed, recovery);
});

const retainReceivedEmail = Effect.fn("retainReceivedEmail")(function* (
  claimed: ClaimedForwardedEmail,
  content: ReceivedEmailContentType
) {
  const retainedAt = yield* DateTime.now;
  const retentionDays = yield* emailIngestRetentionDays;
  const crypto = yield* Crypto.Crypto;
  const sample = RawEmailIngestSample.make({
    id: IngestSampleId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
    receivedEmailId: claimed.receivedEmailId,
    serviceMarket: claimed.serviceMarket,
    locale: claimed.locale,
    timeZone: claimed.timeZone,
    sourceFormat: "notification-email",
    sourceProvider: "resend",
    parserRevision: InterpretationRevision.make(claimed.parserRevision),
    content,
    retainedAt,
    expiresAt: DateTime.add(retainedAt, { days: retentionDays }),
  });
  const encoded = yield* encodeReceivedEmailContent(sample.content);
  const contentHash = Encoding.encodeHex(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(encoded)).pipe(Effect.orDie)
  );
  const sampleId = yield* useCurrentConsentOrDefer(
    claimed,
    insertRawEmailSampleInScope({
      sample,
      userId: claimed.userId,
      encodedContent: encoded,
      contentHash,
      anonymizationCandidate: redactEmailCandidate(candidateContent(content)),
      anonymizationRevision: notificationEmailAnonymizationRevision,
    })
  );
  return Option.map(sampleId, (value) => ({ sampleId: value, contentHash }));
});

const processClaimedForwardedEmailWithConsent = Effect.fn(
  "processClaimedForwardedEmailWithConsent"
)(function* (claimed: ClaimedForwardedEmail) {
  const client = yield* ResendReceivingClient;
  const provider = yield* useCurrentConsentForExternalEffect(
    claimed,
    Effect.result(
      client
        .retrieveEmail(claimed.receivedEmailId)
        .pipe(Effect.withSpan("ingestion.retrieveForwardedEmail"))
    )
  );
  if (Result.isFailure(provider)) {
    const failure: ResendReceivingFailed = provider.failure;
    yield* recoverProviderFailure(claimed, failure.reason);
    return;
  }
  const content = provider.success;
  const { ingestDomain } = yield* externalEndpoints;
  const expectedRecipient = `${claimed.forwardingLocalPart}@${ingestDomain}`;
  if (
    content.receivedEmailId !== claimed.receivedEmailId ||
    !content.to.some((recipient) => normalizedMailbox(recipient) === expectedRecipient)
  ) {
    yield* recoverProviderFailure(claimed, "invalid-provider-response");
    return;
  }

  const retained = yield* retainReceivedEmail(claimed, content);
  if (Option.isNone(retained)) return;
  const { sampleId, contentHash } = retained.value;

  const extractor = yield* NotificationEmailExtractor;
  const extraction = yield* useCurrentConsentForExternalEffect(
    claimed,
    Effect.result(withNotificationEmailExtractionDeadline(extractor.extract(content)))
  );
  if (Result.isFailure(extraction)) {
    yield* useCurrentConsentOrDefer(
      claimed,
      Effect.gen(function* () {
        if (!(yield* ownsForwardedEmailClaimInScope(claimed))) return;
        yield* createReview({
          claimed,
          sampleId,
          reason: "model-unavailable",
          extraction: Option.none(),
        });
      })
    );
    return;
  }
  yield* useCurrentConsentOrDefer(
    claimed,
    finalizeExtraction({ claimed, sampleId, contentHash, extraction: extraction.success })
  );
});

const processClaimedForwardedEmail = Effect.fn("processClaimedForwardedEmail")(function* (
  claimed: ClaimedForwardedEmail
) {
  const armed = yield* withSubjectLock(
    claimed.userId,
    Effect.gen(function* () {
      if (yield* hasCurrentOnboardingConsent(claimed.userId)) {
        return true;
      }
      yield* deferForwardedEmailClaimForConsent(
        claimed,
        DateTime.add(yield* DateTime.now, { days: 1 })
      );
      return false;
    })
  );
  if (armed) {
    yield* processClaimedForwardedEmailWithConsent(claimed).pipe(
      Effect.catchTag("ConsentRevokedDuringEmailProcessing", () => Effect.void)
    );
  }
});

/** Claims and processes at most one durable forwarded email. */
export const processNextForwardedEmail = Effect.fn("processNextForwardedEmail")(function* () {
  const claimed = yield* claimForwardedEmail();
  if (Option.isSome(claimed)) {
    yield* processClaimedForwardedEmail(claimed.value).pipe(
      Effect.withSpan("ingestion.processForwardedEmail", {
        attributes: {
          "fidy.user.id": claimed.value.userId,
          "fidy.received_email.id": claimed.value.receivedEmailId,
        },
      })
    );
  }
});
