import { Data, DateTime, Effect, Option, Random, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { TranscriptText } from "~/core/transcript/model";
import { recordConsentDisclosureDelivery } from "~/shell/consent/repo";
import {
  type DisclosureDeliveryAttemptCapability,
  type DisclosureDeliveryAttemptNumber,
  type DisclosureDeliveryCorrelationToken,
} from "./disclosure-model";
import {
  claimConsentDisclosureDelivery,
  claimNextConsentDisclosureRetry,
  findConsentDisclosureAttemptByCorrelation,
  markConsentDisclosureDeliveryStarted,
  recordConsentDisclosureAttemptAccepted,
  recordConsentDisclosureAttemptDelivered,
  recordConsentDisclosureAttemptSent,
  recordConsentDisclosureDeliveryFailure,
} from "./disclosure-store";
import {
  KapsoClient,
  type KapsoDeliveryCertainty,
  type KapsoDestination,
  KapsoSendFailed,
  kapsoDestinationFor,
} from "./kapso-client";
import type { KapsoDisclosureLifecycleEvidence } from "./kapso-webhook";
import { WhatsAppBusinessPhoneNumberId, type WhatsAppInboundEvent } from "./model";
import type { WhatsAppReceiptInvalid } from "./repo";

export { DisclosureDeliveryCorrelationToken } from "./disclosure-model";

/** Another worker owns disclosure delivery or its durable outcome could not be applied. */
export class ConsentDisclosureDeliveryUnavailable extends Data.TaggedError(
  "ConsentDisclosureDeliveryUnavailable"
)<{}> {}

const sendDisclosure = Effect.fn("WhatsApp.sendDisclosure")(function* (input: {
  readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  readonly destination: KapsoDestination;
  readonly text: TranscriptText;
  readonly correlationToken: DisclosureDeliveryCorrelationToken;
}) {
  const client = yield* KapsoClient;
  return yield* client.sendText({
    businessPhoneNumberId: input.businessPhoneNumberId,
    destination: input.destination,
    text: input.text,
    opaqueCallbackData: Option.some(input.correlationToken),
  });
});

const millisecondsPerSecond = 1_000;

const decideDisclosureRetryAt = Effect.fn("WhatsApp.decideDisclosureRetryAt")(function* (input: {
  readonly certainty: KapsoDeliveryCertainty;
  readonly attemptNumber: DisclosureDeliveryAttemptNumber;
  readonly occurredAt: DateTime.Utc;
  readonly automaticRetry: boolean;
}) {
  if (input.certainty !== "rejected" || !input.automaticRetry || input.attemptNumber >= 4) {
    return Option.none<DateTime.Utc>();
  }
  const baseSeconds = 2 ** (input.attemptNumber - 1);
  const jitterMilliseconds = yield* Random.nextIntBetween(
    0,
    baseSeconds * millisecondsPerSecond + 1
  );
  return Option.some(
    DateTime.add(input.occurredAt, {
      milliseconds: baseSeconds * millisecondsPerSecond + jitterMilliseconds,
    })
  );
});

const applyDelivered = Effect.fn("WhatsApp.applyDisclosureDelivered")(function* (
  input: Parameters<typeof recordConsentDisclosureAttemptDelivered>[0]
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        if (!(yield* recordConsentDisclosureAttemptDelivered(input))) return Option.none();
        const recorded = yield* recordConsentDisclosureDelivery(input);
        if (Option.isNone(recorded)) return yield* new ConsentDisclosureDeliveryUnavailable();
        return recorded;
      })
    )
    .pipe(Effect.catchTag("SqlError", Effect.die));
});

type DisclosureLifecycleDecision =
  | Readonly<{
      readonly _tag: "SendAccepted";
      readonly message: Parameters<typeof recordConsentDisclosureAttemptAccepted>[0]["message"];
      readonly occurredAt: DateTime.Utc;
    }>
  | Readonly<{
      readonly _tag: "Delivered";
      readonly message: Parameters<typeof recordConsentDisclosureAttemptDelivered>[0]["message"];
      readonly occurredAt: DateTime.Utc;
    }>
  | Readonly<{
      readonly _tag: "Failed";
      readonly failure: KapsoSendFailed;
      readonly occurredAt: DateTime.Utc;
      readonly providerEvidence: boolean;
    }>
  | Readonly<{
      readonly _tag: "Sent";
      readonly message: Parameters<typeof recordConsentDisclosureAttemptSent>[0]["message"];
      readonly occurredAt: DateTime.Utc;
    }>;

const applyLifecycleDecision = Effect.fn("WhatsApp.applyDisclosureLifecycleDecision")(function* (
  attempt: DisclosureDeliveryAttemptCapability & {
    readonly attemptNumber: DisclosureDeliveryAttemptNumber;
  },
  decision: DisclosureLifecycleDecision
) {
  if (decision._tag === "Sent") {
    const retained = yield* recordConsentDisclosureAttemptSent({
      ...attempt,
      message: decision.message,
      occurredAt: decision.occurredAt,
    });
    return retained ? ("applied" as const) : ("ignored" as const);
  }
  if (decision._tag === "SendAccepted") {
    const retained = yield* recordConsentDisclosureAttemptAccepted({
      ...attempt,
      message: decision.message,
      acceptedAt: decision.occurredAt,
    });
    return retained ? ("applied" as const) : ("ignored" as const);
  }
  if (decision._tag === "Delivered") {
    const applied = yield* applyDelivered({
      ...attempt,
      message: decision.message,
      deliveredAt: decision.occurredAt,
    });
    return Option.isSome(applied) ? ("applied" as const) : ("ignored" as const);
  }
  const retryAt = yield* decideDisclosureRetryAt({
    certainty: decision.failure.deliveryCertainty,
    attemptNumber: attempt.attemptNumber,
    occurredAt: decision.occurredAt,
    automaticRetry: decision.failure.automaticRetry,
  });
  const retained = yield* recordConsentDisclosureDeliveryFailure({
    ...attempt,
    reason: decision.failure.safeReason,
    certainty: decision.failure.deliveryCertainty,
    occurredAt: decision.occurredAt,
    providerEvidence: decision.providerEvidence,
    retryAt,
  });
  return retained ? ("applied" as const) : ("ignored" as const);
});

const executeClaim = Effect.fn("WhatsApp.executeDisclosureClaim")(function* (
  input: DisclosureDeliveryAttemptCapability & {
    readonly attemptNumber: DisclosureDeliveryAttemptNumber;
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
    readonly startedAt: DateTime.Utc;
    readonly destination: KapsoDestination;
    readonly text: TranscriptText;
    readonly propagateTerminalFailure: boolean;
  }
) {
  const started = yield* markConsentDisclosureDeliveryStarted(
    {
      exchangeId: input.exchangeId,
      attemptId: input.attemptId,
      businessPhoneNumberId: input.businessPhoneNumberId,
    },
    input.startedAt
  );
  if (!started) return yield* new ConsentDisclosureDeliveryUnavailable();

  const sent = yield* Effect.result(
    sendDisclosure({
      businessPhoneNumberId: input.businessPhoneNumberId,
      destination: input.destination,
      text: input.text,
      correlationToken: input.correlationToken,
    })
  );
  const attempt = {
    exchangeId: input.exchangeId,
    attemptId: input.attemptId,
    attemptNumber: input.attemptNumber,
    correlationToken: input.correlationToken,
  };
  if (Result.isFailure(sent)) {
    const applied = yield* applyLifecycleDecision(attempt, {
      _tag: "Failed",
      failure: sent.failure,
      occurredAt: DateTime.max(yield* DateTime.now, input.startedAt),
      providerEvidence: false,
    });
    if (applied === "ignored") return yield* new ConsentDisclosureDeliveryUnavailable();
    if (input.propagateTerminalFailure && !sent.failure.automaticRetry) return yield* sent.failure;
    return;
  }

  const applied = yield* applyLifecycleDecision(attempt, {
    _tag: "SendAccepted",
    message: sent.success.messageEvidence,
    occurredAt: sent.success.sentAt,
  });
  if (applied === "ignored") return yield* new ConsentDisclosureDeliveryUnavailable();
});

/**
 * Starts the sole durable WhatsApp delivery for a pending Consent exchange. The module owns claim
 * expiry, exact-attempt correlation, provider invocation, retry scheduling, and atomic Consent
 * advancement. The caller supplies only authenticated routing context, disclosure text, and work
 * that must commit before the provider seam is crossed.
 */
export const requestConsentDisclosureDelivery = Effect.fn("WhatsApp.requestDisclosureDelivery")(
  function* (input: {
    readonly event: WhatsAppInboundEvent;
    readonly exchangeId: DisclosureDeliveryAttemptCapability["exchangeId"];
    readonly text: TranscriptText;
    readonly beforeProviderCall: Effect.Effect<void, WhatsAppReceiptInvalid, SqlClient.SqlClient>;
  }) {
    const claim = yield* claimConsentDisclosureDelivery(input.exchangeId, input.event.receivedAt);
    if (Option.isNone(claim)) return yield* new ConsentDisclosureDeliveryUnavailable();
    yield* input.beforeProviderCall;
    yield* executeClaim({
      ...claim.value,
      exchangeId: input.exchangeId,
      businessPhoneNumberId: input.event.businessPhoneNumberId,
      destination: kapsoDestinationFor(input.event.caller),
      text: input.text,
      startedAt: input.event.receivedAt,
      propagateTerminalFailure: true,
    });
  }
);

/**
 * Applies authenticated provider lifecycle evidence by opaque correlation. Replays and stale
 * history are ignored; nonterminal `sent` evidence advances chronology only. Verified delivery
 * advances Consent atomically, while definitive failures alone may schedule a bounded retry.
 */
export const applyConsentDisclosureLifecycle = Effect.fn("WhatsApp.applyDisclosureLifecycle")(
  function* (evidence: KapsoDisclosureLifecycleEvidence) {
    const correlated = yield* findConsentDisclosureAttemptByCorrelation(evidence.correlationToken);
    if (Option.isNone(correlated)) return "ignored" as const;
    const attempt = { ...correlated.value, correlationToken: evidence.correlationToken };
    if (evidence.outcome === "sent") {
      return yield* applyLifecycleDecision(attempt, {
        _tag: "Sent",
        message: evidence.messageEvidence,
        occurredAt: evidence.occurredAt,
      });
    }
    if (evidence.outcome === "accepted") {
      return yield* applyLifecycleDecision(attempt, {
        _tag: "Delivered",
        message: evidence.messageEvidence,
        occurredAt: evidence.occurredAt,
      });
    }
    return yield* applyLifecycleDecision(attempt, {
      _tag: "Failed",
      failure: new KapsoSendFailed({
        deliveryCertainty: "rejected",
        safeReason: evidence.reason,
        automaticRetry: evidence.automaticRetry,
        responseStatus: Option.none(),
      }),
      occurredAt: evidence.occurredAt,
      providerEvidence: true,
    });
  }
);

/**
 * Processes at most one due definitive retry. Ambiguous attempts are never sent again and await
 * authenticated lifecycle webhooks; definitive transient rejection creates the next of at most
 * four attempts. Returns false only when no retry is due.
 */
export const processDueConsentDisclosureDelivery = Effect.fn("WhatsApp.processDueDisclosure")(
  function* (now: DateTime.Utc) {
    const claimed = yield* claimNextConsentDisclosureRetry(now);
    if (Option.isNone(claimed)) return false;
    const attempt = claimed.value;
    const businessPhoneNumberId = yield* Schema.decodeEffect(WhatsAppBusinessPhoneNumberId)(
      attempt.businessPhoneNumberId
    ).pipe(Effect.orDie);
    const text = yield* Schema.decodeEffect(TranscriptText)(attempt.disclosureText).pipe(
      Effect.orDie
    );
    yield* executeClaim({
      ...attempt,
      businessPhoneNumberId,
      destination: { recipient: attempt.businessScopedUserId, sandboxPhone: Option.none() },
      text,
      startedAt: now,
      propagateTerminalFailure: false,
    });
    return true;
  }
);
