import {
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Encoding,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import {
  type EmailRawSampleReviewReason,
  RawEmailIngestSample,
  ReceivedEmailContent,
  type ReceivedEmailContent as ReceivedEmailContentType,
} from "~/core/ingestion/model";
import {
  type ForwardedEmailProviderFailureReason,
  describeForwardedEmailProviderFailure,
  redactEmailCandidate,
} from "~/core/ingestion/rules";
import { IngestSampleId, NeedsReviewItemId } from "~/core/ingestion/reference";
import {
  TransactionExtraction,
  type TransactionExtraction as TransactionExtractionType,
} from "~/core/transactions/model";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { resolveAccessTierInScope } from "~/shell/_shared/access-tier";
import {
  hasCurrentOnboardingConsent,
  onboardingConsentStandingInScope,
  withSubjectLock,
} from "~/shell/consent/repo";
import { withConsentExternalEffectLock } from "~/shell/db/advisory-lock";
import { captureNotificationEmailTransactionInScope } from "~/shell/transactions/mutations";
import { UnknownJsonString } from "~/schema-compatibility";
import { normalizedMailbox } from "./email-address";
import {
  type ForwardedEmailExecutionContext,
  type ForwardedEmailInterpretation,
  type ForwardedEmailReceiptLifecycle,
  completeForwardedEmailWithReviewInScope,
  completeForwardedEmailWithTransactionInScope,
  deferForwardedEmailForConsentInScope,
  findForwardedEmailInterpretationInScope,
  findForwardedEmailReceiptLifecycle,
  findForwardedEmailReceiptLifecycleInScope,
  findRetainedForwardedEmailInScope,
  insertRawEmailSampleInScope,
  resolveForwardedEmailUser,
  revokeForwardedEmailForConsentInScope,
  storeForwardedEmailInterpretationInScope,
} from "./email-forwarding-repo";
import {
  type NotificationEmailInterpretationEvidence,
  interpretNotificationEmail,
} from "~/shell/ingestion/email-interpretation/interpret";
import { emailIngestRetentionDays } from "./email-retention";
import type { ForwardedEmailWorkflowPayload } from "./forwarded-email-execution";
import { ResendReceivingClient } from "./resend-receiving-client";

class ConsentRevokedDuringEmailProcessing extends Data.TaggedError(
  "ConsentRevokedDuringEmailProcessing"
)<{}> {}

/** Expected bounded retrieval failure persisted by the workflow Activity. */
export class ForwardedEmailRetrievalFailed extends Schema.Error<ForwardedEmailRetrievalFailed>(
  "ForwardedEmailRetrievalFailed"
)({
  _tag: Schema.tag("ForwardedEmailRetrievalFailed"),
  reason: Schema.Literals(["provider-unavailable", "invalid-provider-response", "resource-limit"]),
}) {}

class ForwardedEmailWorkerConfig extends Context.Service<
  ForwardedEmailWorkerConfig,
  Readonly<{ ingestDomain: string; retentionDays: number }>
>()("@fidy/server/shell/ingestion/email-worker/ForwardedEmailWorkerConfig") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const { ingestDomain } = yield* externalEndpoints;
      const retentionDays = yield* emailIngestRetentionDays;
      return { ingestDomain, retentionDays };
    })
  );
}

/** Production configuration Adapter for bounded retrieval and evidence retention. */
export const ForwardedEmailWorkerConfigLive = ForwardedEmailWorkerConfig.layer;

/** Durable revision attached to review decisions without a recognized format revision. */
export const notificationEmailInterpreterRevision = "notification-email-interpreter-v1";
/** Durable revision attached to automatic value-free redaction candidates. */
export const notificationEmailAnonymizationRevision = "email-redaction-candidate-v1";

const encodeReceivedEmailContent = Effect.fn(function* (content: ReceivedEmailContentType) {
  const encoded = yield* Schema.encodeEffect(ReceivedEmailContent)(content);
  return yield* Schema.encodeEffect(UnknownJsonString)(encoded);
}, Effect.orDie);

const candidateContent = (content: ReceivedEmailContentType): string =>
  [
    content.subject,
    Option.getOrElse(content.text, () => ""),
    Option.getOrElse(content.html, () => ""),
  ].join("\n");

type RoutedForwardedEmailLifecycle = ForwardedEmailReceiptLifecycle | Readonly<{ _tag: "Stale" }>;

type ForwardedEmailStepOutcome = "completed" | "consent-deferred" | "revoked" | "expired" | "stale";

type RetrievalLifecycleOutcome = Readonly<{
  _tag: "ConsentDeferred" | "Completed" | "Revoked" | "Expired" | "Stale";
}>;

const terminalLifecycleOutcomes = {
  Completed: "completed",
  Revoked: "revoked",
  Expired: "expired",
} as const;

/** Projects one persisted terminal receipt lifecycle tag into its workflow outcome. */
export const forwardedEmailTerminalOutcome = (
  lifecycleTag: Exclude<ForwardedEmailReceiptLifecycle, { readonly _tag: "Actionable" }>["_tag"]
): Exclude<ForwardedEmailStepOutcome, "consent-deferred" | "stale"> =>
  terminalLifecycleOutcomes[lifecycleTag];

const routedLifecycleOutcome = (
  lifecycle: Exclude<RoutedForwardedEmailLifecycle, { readonly _tag: "Actionable" }>
): Exclude<ForwardedEmailStepOutcome, "consent-deferred"> =>
  lifecycle._tag === "Stale" ? "stale" : forwardedEmailTerminalOutcome(lifecycle._tag);

const retrievalLifecycleTags = {
  "consent-deferred": "ConsentDeferred",
  completed: "Completed",
  revoked: "Revoked",
  expired: "Expired",
  stale: "Stale",
} as const satisfies Record<ForwardedEmailStepOutcome, RetrievalLifecycleOutcome["_tag"]>;

const retrievalOutcomeAfterConsentLoss = (
  outcome: ForwardedEmailStepOutcome
): RetrievalLifecycleOutcome => ({ _tag: retrievalLifecycleTags[outcome] });

const loadRoutedExecutionLifecycle = Effect.fn(function* (payload: ForwardedEmailWorkflowPayload) {
  const owner = yield* resolveForwardedEmailUser(payload.receivedEmailId);
  if (Option.isNone(owner) || owner.value !== payload.userId) return { _tag: "Stale" as const };
  const lifecycle = yield* findForwardedEmailReceiptLifecycle(
    payload.userId,
    payload.receivedEmailId
  );
  return Option.isSome(lifecycle) ? lifecycle.value : { _tag: "Stale" as const };
});

const useCurrentConsentForExternalEffect = Effect.fn(function* <A, E, R>(
  context: ForwardedEmailExecutionContext,
  use: Effect.Effect<A, E, R>
) {
  return yield* withConsentExternalEffectLock(
    context.userId,
    Effect.gen(function* () {
      const authorized = yield* withSubjectLock(
        context.userId,
        hasCurrentOnboardingConsent(context.userId)
      );
      if (!authorized) return yield* new ConsentRevokedDuringEmailProcessing();
      return yield* use;
    })
  );
});

const classifyConsentLossInScope = Effect.fn(function* (context: ForwardedEmailExecutionContext) {
  const explicitlyRevoked = (yield* onboardingConsentStandingInScope(context.userId)) === "revoked";
  if (explicitlyRevoked) {
    yield* revokeForwardedEmailForConsentInScope({ context, revokedAt: yield* DateTime.now });
  } else {
    yield* deferForwardedEmailForConsentInScope(context);
  }
  const lifecycle = yield* findForwardedEmailReceiptLifecycleInScope(
    context.userId,
    context.receivedEmailId
  );
  if (Option.isNone(lifecycle)) return "stale" as const;
  return lifecycle.value._tag === "Actionable"
    ? ("consent-deferred" as const)
    : forwardedEmailTerminalOutcome(lifecycle.value._tag);
});

const classifyConsentLoss = Effect.fn(function* (context: ForwardedEmailExecutionContext) {
  return yield* withSubjectLock(context.userId, classifyConsentLossInScope(context));
});

const persistForwardedEmailInterpretation = Effect.fn(function* (input: {
  readonly context: ForwardedEmailExecutionContext;
  readonly interpretation: ForwardedEmailInterpretation;
}) {
  return yield* withSubjectLock(
    input.context.userId,
    Effect.gen(function* () {
      if (!(yield* hasCurrentOnboardingConsent(input.context.userId))) return false;
      return yield* storeForwardedEmailInterpretationInScope(input.context, input.interpretation);
    })
  );
});

const retainReceivedEmail = Effect.fn(function* (
  context: ForwardedEmailExecutionContext,
  content: ReceivedEmailContentType
) {
  const retainedAt = yield* DateTime.now;
  const { retentionDays } = yield* ForwardedEmailWorkerConfig;
  const crypto = yield* Crypto.Crypto;
  const sample = RawEmailIngestSample.make({
    id: IngestSampleId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
    receivedEmailId: context.receivedEmailId,
    serviceMarket: context.serviceMarket,
    locale: context.locale,
    timeZone: context.timeZone,
    sourceFormat: "notification-email",
    sourceProvider: "resend",
    parserRevision: InterpretationRevision.make(context.parserRevision),
    content,
    retainedAt,
    expiresAt: DateTime.add(retainedAt, { days: retentionDays }),
  });
  const encoded = yield* encodeReceivedEmailContent(sample.content);
  const contentHash = Encoding.encodeHex(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(encoded)).pipe(Effect.orDie)
  );
  const sampleId = yield* withSubjectLock(
    context.userId,
    Effect.gen(function* () {
      if (!(yield* hasCurrentOnboardingConsent(context.userId))) {
        return yield* new ConsentRevokedDuringEmailProcessing();
      }
      return yield* insertRawEmailSampleInScope({
        sample,
        userId: context.userId,
        encodedContent: encoded,
        contentHash,
        anonymizationCandidate: redactEmailCandidate(candidateContent(content)),
        anonymizationRevision: notificationEmailAnonymizationRevision,
      });
    })
  );
  return { sampleId, contentHash };
});

const isExpectedReceivedEmail = (
  context: ForwardedEmailExecutionContext,
  content: ReceivedEmailContentType,
  ingestDomain: string
): boolean =>
  content.receivedEmailId === context.receivedEmailId &&
  content.to.some(
    (recipient) => normalizedMailbox(recipient) === `${context.forwardingLocalPart}@${ingestDomain}`
  );

/** Retrieves and retains bounded provider material without returning it to workflow storage. */
export const retrieveForwardedEmail = Effect.fn("ForwardedEmail.retrieve")(function* (
  payload: ForwardedEmailWorkflowPayload
) {
  const lifecycle = yield* loadRoutedExecutionLifecycle(payload);
  if (lifecycle._tag !== "Actionable") {
    return retrievalOutcomeAfterConsentLoss(routedLifecycleOutcome(lifecycle));
  }
  const context = lifecycle.context;
  const retained = yield* withSubjectLock(
    context.userId,
    findRetainedForwardedEmailInScope(context)
  );
  if (Option.isSome(retained)) return { _tag: "Retrieved" as const };
  const client = yield* ResendReceivingClient;
  const received = yield* useCurrentConsentForExternalEffect(
    context,
    client.retrieveEmail(context.receivedEmailId)
  ).pipe(
    Effect.asSome,
    Effect.catchTags({
      ConsentRevokedDuringEmailProcessing: () =>
        Effect.succeed(Option.none<ReceivedEmailContentType>()),
      ResendReceivingFailed: (failure) =>
        Effect.fail(ForwardedEmailRetrievalFailed.make({ reason: failure.reason })),
    })
  );
  if (Option.isNone(received)) {
    return retrievalOutcomeAfterConsentLoss(yield* classifyConsentLoss(context));
  }
  const content = received.value;
  const { ingestDomain } = yield* ForwardedEmailWorkerConfig;
  if (!isExpectedReceivedEmail(context, content, ingestDomain)) {
    return yield* ForwardedEmailRetrievalFailed.make({ reason: "invalid-provider-response" });
  }
  const stored = yield* retainReceivedEmail(context, content).pipe(
    Effect.asSome,
    Effect.catchTag("ConsentRevokedDuringEmailProcessing", () =>
      Effect.succeed(Option.none<Readonly<{ sampleId: IngestSampleId; contentHash: string }>>())
    )
  );
  if (Option.isNone(stored)) {
    return retrievalOutcomeAfterConsentLoss(yield* classifyConsentLoss(context));
  }
  return { _tag: "Retrieved" as const };
});

/** Interprets retained provider material and stores the bounded result in User-owned storage. */
export const interpretForwardedEmail = Effect.fn("ForwardedEmail.interpret")(function* (
  payload: ForwardedEmailWorkflowPayload
) {
  const lifecycle = yield* loadRoutedExecutionLifecycle(payload);
  if (lifecycle._tag !== "Actionable") {
    return { outcome: routedLifecycleOutcome(lifecycle) } as const;
  }
  const context = lifecycle.context;
  const prepared = yield* withSubjectLock(
    context.userId,
    findForwardedEmailInterpretationInScope(context)
  );
  if (Option.isSome(prepared)) return { outcome: "prepared" as const };
  const retained = yield* withSubjectLock(
    context.userId,
    findRetainedForwardedEmailInScope(context)
  );
  if (Option.isNone(retained)) return { outcome: "evidence-expired" as const };
  const interpretation = yield* interpretNotificationEmail({
    content: retained.value.content,
    context: {
      serviceMarket: context.serviceMarket,
      locale: context.locale,
      timeZone: context.timeZone,
    },
  });
  const stored = yield* persistForwardedEmailInterpretation({ context, interpretation });
  return stored
    ? { outcome: "prepared" as const }
    : { outcome: yield* classifyConsentLoss(context) };
});

type ReviewInput = Readonly<{
  context: ForwardedEmailExecutionContext;
  sampleId: IngestSampleId;
  reason: EmailRawSampleReviewReason;
  extraction: Option.Option<TransactionExtraction>;
}>;

const createReview = Effect.fnUntraced(function* (input: ReviewInput) {
  const crypto = yield* Crypto.Crypto;
  yield* completeForwardedEmailWithReviewInScope({
    context: input.context,
    reviewId: NeedsReviewItemId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
    evidence: {
      _tag: "RawSample",
      sampleId: input.sampleId,
      reason: input.reason,
      extraction: input.extraction,
    },
    extractorRevision: notificationEmailInterpreterRevision,
    issues: [
      {
        path: "",
        message:
          input.reason === "canonical-validation-failed"
            ? "The interpreted email could not be captured as a canonical Transaction."
            : "The notification email requires review because deterministic interpretation was not safe.",
      },
    ],
    createdAt: yield* DateTime.now,
  });
});

type SettlementExtraction = Readonly<{
  context: ForwardedEmailExecutionContext;
  sampleId: IngestSampleId;
  contentHash: string;
  extraction: TransactionExtractionType;
  evidence: NotificationEmailInterpretationEvidence;
}>;

const settleExtraction = Effect.fn(function* (input: SettlementExtraction) {
  const { contentHash, extraction, sampleId, context } = input;
  const decoded = Schema.encodeUnknownResult(TransactionExtraction)(extraction);
  if (Result.isFailure(decoded)) {
    yield* createReview({
      context,
      sampleId,
      reason: "canonical-validation-failed",
      extraction: Option.none(),
    });
    return;
  }
  const tier = yield* resolveAccessTierInScope(context.userId, yield* DateTime.now);
  const captured = yield* Effect.result(
    captureNotificationEmailTransactionInScope({
      userId: context.userId,
      caller: { accessCaller: { _tag: "PAT", capabilities: ["write"] }, tier },
      extraction,
      context: {
        serviceMarket: context.serviceMarket,
        locale: context.locale,
        timeZone: context.timeZone,
      },
      attestation: {
        receivedEmailId: context.receivedEmailId,
        messageEvidence: {
          channel: "email",
          provider: "resend",
          providerMessageId: context.receivedEmailId,
        },
        messageContentSha256: contentHash,
        sourceFormat: "notification-email",
        parserRevision: InterpretationRevision.make(context.parserRevision),
        extractorRevision: input.evidence.revision,
        deterministicInterpretation: {
          formatId: input.evidence.formatId,
          currencyBasis: input.evidence.currencyBasis,
          accountHints: input.evidence.accountHints,
        },
      },
    })
  );
  if (Result.isFailure(captured)) {
    yield* createReview({
      context,
      sampleId,
      reason: "canonical-validation-failed",
      extraction: Option.some(extraction),
    });
    return;
  }
  yield* completeForwardedEmailWithTransactionInScope(
    context,
    captured.success.id,
    yield* DateTime.now
  );
});

const withSettlementConsent = Effect.fn("ForwardedEmail.withSettlementConsent")(function* <A, E, R>(
  payload: ForwardedEmailWorkflowPayload,
  settle: (context: ForwardedEmailExecutionContext) => Effect.Effect<A, E, R>
) {
  const routed = yield* loadRoutedExecutionLifecycle(payload);
  if (routed._tag !== "Actionable") {
    return { outcome: routedLifecycleOutcome(routed) } as const;
  }
  return yield* withSubjectLock(
    routed.context.userId,
    Effect.gen(function* () {
      const lifecycle = yield* findForwardedEmailReceiptLifecycleInScope(
        routed.context.userId,
        routed.context.receivedEmailId
      );
      if (Option.isNone(lifecycle)) return { outcome: "stale" as const };
      if (lifecycle.value._tag !== "Actionable") {
        return { outcome: forwardedEmailTerminalOutcome(lifecycle.value._tag) } as const;
      }
      if (lifecycle.value.context.status === "deferred") {
        return { outcome: "consent-deferred" as const };
      }
      if (yield* hasCurrentOnboardingConsent(lifecycle.value.context.userId)) {
        return yield* settle(lifecycle.value.context);
      }
      return { outcome: yield* classifyConsentLossInScope(lifecycle.value.context) } as const;
    })
  );
});

/** Commits exactly one Transaction or NeedsReviewItem from a prepared interpretation. */
export const settleForwardedEmail = Effect.fn("ForwardedEmail.settle")(
  (payload: ForwardedEmailWorkflowPayload) =>
    withSettlementConsent(
      payload,
      Effect.fnUntraced(function* (context) {
        const retained = yield* findRetainedForwardedEmailInScope(context);
        const interpretation = yield* findForwardedEmailInterpretationInScope(context);
        if (Option.isNone(retained) || Option.isNone(interpretation)) {
          return { outcome: "evidence-expired" as const };
        }
        if (interpretation.value._tag === "NeedsReview") {
          yield* createReview({
            context,
            sampleId: retained.value.id,
            reason: interpretation.value.reason,
            extraction: Option.none(),
          });
        } else {
          yield* settleExtraction({
            context,
            sampleId: retained.value.id,
            contentHash: retained.value.contentHash,
            extraction: interpretation.value.extraction,
            evidence: interpretation.value.evidence,
          });
        }
        return { outcome: "completed" as const };
      })
    )
);

/** Commits provider-retrieval exhaustion as the existing visible NeedsReviewItem outcome. */
export const settleForwardedEmailRetrievalFailure = Effect.fn(
  "ForwardedEmail.settleRetrievalFailure"
)((payload: ForwardedEmailWorkflowPayload, reason: ForwardedEmailProviderFailureReason) =>
  withSettlementConsent(
    payload,
    Effect.fnUntraced(function* (context) {
      const crypto = yield* Crypto.Crypto;
      yield* completeForwardedEmailWithReviewInScope({
        context,
        reviewId: NeedsReviewItemId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        evidence: { _tag: "ProviderMessage", reason: "provider-retrieval-failed" },
        extractorRevision: notificationEmailInterpreterRevision,
        issues: [describeForwardedEmailProviderFailure(reason)],
        createdAt: yield* DateTime.now,
      });
      return { outcome: "completed" as const };
    })
  )
);
