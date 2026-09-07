import {
  Cause,
  Config,
  Data,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Random,
  Result,
  Schema,
} from "effect";
import { type SqlClient } from "effect/unstable/sql";
import { Activity, DurableClock, DurableDeferred } from "effect/unstable/workflow";
import { type PendingConsentExchangeId } from "~/core/consent/model";
import { TranscriptText } from "~/core/transcript/model";
import { findPendingConsentExchange, recordConsentDisclosureDelivery } from "~/shell/consent/repo";
import {
  type DisclosureDeliveryAttemptCapability,
  DisclosureDeliveryAttemptNumber,
  type DisclosureDeliveryEvidence,
} from "./disclosure-model";
import {
  armConsentDisclosureAttempt,
  findConsentDisclosureAttemptByCorrelation,
  findConsentDisclosureDeliveryState,
  findConsentDisclosureWork,
  findPendingConsentDisclosureRequests,
  lockConsentDisclosure,
  recordConsentDisclosureAttemptAccepted,
  recordConsentDisclosureAttemptDelivered,
  recordConsentDisclosureAttemptSent,
  recordConsentDisclosureDeliveryFailure,
  requestConsentDisclosure,
} from "./disclosure-store";
import {
  ConsentDisclosureWorkflow,
  consentDisclosureEvidenceQueue,
  consentDisclosureQueue,
  disclosureEvidenceChanged,
  disclosureEvidenceQueueId,
} from "./disclosure-workflow";
import {
  observeConsentDisclosureAttempt,
  observeConsentDisclosureQueue,
  observeConsentDisclosureResume,
  recordConsentDisclosureOutcome,
} from "./disclosure-observation";
import { KapsoClient, type KapsoSendFailed, kapsoDestinationFor } from "./kapso-client";
import type { KapsoDisclosureLifecycleEvidence } from "./kapso-webhook";
import type { WhatsAppInboundEvent } from "./model";
import type { WhatsAppReceiptInvalid } from "./repo";

export { DisclosureDeliveryCorrelationToken } from "./disclosure-model";

/** Delivery cannot be admitted or verified evidence cannot be committed consistently. */
export class ConsentDisclosureDeliveryUnavailable extends Data.TaggedError(
  "ConsentDisclosureDeliveryUnavailable"
)<{}> {}

/**
 * Accepts one disclosure without waiting for Kapso. Receipt handoff, immutable routing, and native
 * queue publication commit together. Duplicates converge on the same exchange execution.
 */
export const requestConsentDisclosureDelivery = Effect.fn("WhatsApp.requestDisclosureDelivery")(
  function* (input: {
    readonly event: WhatsAppInboundEvent;
    readonly exchangeId: PendingConsentExchangeId;
    readonly beforeProviderCall: Effect.Effect<void, WhatsAppReceiptInvalid, SqlClient.SqlClient>;
  }) {
    const now = yield* DateTime.now;
    const queue = yield* consentDisclosureQueue;
    const destination = kapsoDestinationFor(input.event.caller);
    yield* lockConsentDisclosure(
      input.exchangeId,
      Effect.gen(function* () {
        const pending = yield* findPendingConsentExchange(input.event.caller);
        if (Option.isNone(pending) || pending.value.id !== input.exchangeId) {
          return yield* new ConsentDisclosureDeliveryUnavailable();
        }
        const eligible = yield* requestConsentDisclosure({
          exchangeId: input.exchangeId,
          businessPhoneNumberId: input.event.businessPhoneNumberId,
          sandboxPhone: destination.sandboxPhone,
          now,
        });
        if (!eligible) return;
        yield* input.beforeProviderCall;
        yield* queue
          .offer({ exchangeId: input.exchangeId, revision: 1 }, { id: input.exchangeId })
          .pipe(Effect.orDie);
      })
    );
  }
);

const applyDelivered = Effect.fn(function* (
  input: Parameters<typeof recordConsentDisclosureAttemptDelivered>[0]
) {
  if (!(yield* recordConsentDisclosureAttemptDelivered(input))) return false;
  const recorded = yield* recordConsentDisclosureDelivery(input);
  if (Option.isNone(recorded)) return yield* new ConsentDisclosureDeliveryUnavailable();
  return true;
});

const applyFailure = (
  attempt: DisclosureDeliveryAttemptCapability & {
    readonly attemptNumber: DisclosureDeliveryAttemptNumber;
  },
  failure: KapsoSendFailed,
  occurredAt: DateTime.Utc
): ReturnType<typeof recordConsentDisclosureDeliveryFailure> =>
  recordConsentDisclosureDeliveryFailure({
    ...attempt,
    reason: failure.safeReason,
    certainty: failure.deliveryCertainty,
    occurredAt,
    providerEvidence: false,
    message: Option.none(),
    retryable: failure.deliveryCertainty === "rejected" && failure.automaticRetry,
  });

const observeEvidence = Effect.fn(function* (evidence: DisclosureDeliveryEvidence) {
  switch (evidence.state) {
    case "started":
    case "reconciliation-required":
      return yield* recordConsentDisclosureOutcome("ambiguous");
    case "definitively-failed":
      return yield* recordConsentDisclosureOutcome(evidence.retryable ? "retrying" : "rejected");
    case "delivered":
    case "retry-exhausted":
      return yield* recordConsentDisclosureOutcome(evidence.state);
  }
});

/**
 * Performs at most one newly armed provider call. Re-entry never repeats an armed attempt. This
 * finite channel-worker seam retains provider evidence; the Workflow alone decides when to retry.
 */
export const performConsentDisclosureAttempt = Effect.fn("WhatsApp.performDisclosureAttempt")(
  function* (exchangeId: PendingConsentExchangeId, attemptNumber: DisclosureDeliveryAttemptNumber) {
    const now = yield* DateTime.now;
    const work = yield* findConsentDisclosureWork(exchangeId, now);
    if (Option.isNone(work)) return;
    const armed = yield* armConsentDisclosureAttempt(exchangeId, attemptNumber, now);
    if (Option.isNone(armed)) return;
    const attempt = { ...armed.value, exchangeId };
    const text = yield* Schema.decodeEffect(TranscriptText)(work.value.disclosureText).pipe(
      Effect.orDie
    );
    const client = yield* KapsoClient;
    const result = yield* client
      .sendText({
        businessPhoneNumberId: work.value.businessPhoneNumberId,
        destination: {
          recipient: work.value.businessScopedUserId,
          sandboxPhone: work.value.sandboxPhone,
        },
        text,
        opaqueCallbackData: Option.some(attempt.correlationToken),
      })
      .pipe(Effect.result);
    yield* lockConsentDisclosure(
      exchangeId,
      Result.match(result, {
        onFailure: (failure) =>
          DateTime.now.pipe(Effect.flatMap((at) => applyFailure(attempt, failure, at))),
        onSuccess: (sent) =>
          recordConsentDisclosureAttemptAccepted({
            ...attempt,
            message: sent.messageEvidence,
            acceptedAt: sent.sentAt,
          }),
      })
    );
    yield* readDisclosure(exchangeId);
  },
  (work, _exchangeId, attemptNumber) => observeConsentDisclosureAttempt(work, attemptNumber)
);

const applyLifecycleEvidence = Effect.fn(function* (
  attempt: DisclosureDeliveryAttemptCapability & {
    readonly attemptNumber: DisclosureDeliveryAttemptNumber;
  },
  evidence: KapsoDisclosureLifecycleEvidence
) {
  switch (evidence.outcome) {
    case "sent":
      return yield* recordConsentDisclosureAttemptSent({
        ...attempt,
        message: evidence.messageEvidence,
        occurredAt: evidence.occurredAt,
      });
    case "accepted":
      return yield* applyDelivered({
        ...attempt,
        message: evidence.messageEvidence,
        deliveredAt: evidence.occurredAt,
      });
    case "failed":
      return yield* recordConsentDisclosureDeliveryFailure({
        ...attempt,
        reason: evidence.reason,
        certainty: "rejected",
        occurredAt: evidence.occurredAt,
        providerEvidence: true,
        message: Option.some(evidence.messageEvidence),
        retryable: evidence.automaticRetry,
      });
  }
});

/**
 * Applies authenticated exact-attempt evidence and atomically records its durable wake command.
 * Consent advancement is in that same transaction. The signal contains no provider facts; resumed
 * execution re-reads the owner. Replays and conflicting chronology cause neither writes nor wakes.
 */
export const applyConsentDisclosureLifecycle = Effect.fn("WhatsApp.applyDisclosureLifecycle")(
  function* (evidence: KapsoDisclosureLifecycleEvidence) {
    const correlated = yield* findConsentDisclosureAttemptByCorrelation(evidence.correlationToken);
    if (Option.isNone(correlated)) return "ignored" as const;
    return yield* lockConsentDisclosure(
      correlated.value.exchangeId,
      Effect.gen(function* () {
        const work = yield* findConsentDisclosureWork(
          correlated.value.exchangeId,
          yield* DateTime.now
        );
        if (Option.isNone(work)) return "ignored" as const;
        const current = yield* findConsentDisclosureAttemptByCorrelation(evidence.correlationToken);
        if (Option.isNone(current)) return "ignored" as const;
        const attempt = { ...current.value, correlationToken: evidence.correlationToken };
        const applied = yield* applyLifecycleEvidence(attempt, evidence);
        if (!applied) return "ignored" as const;
        const queue = yield* consentDisclosureEvidenceQueue;
        yield* queue
          .offer(
            {
              revision: 1,
              exchangeId: attempt.exchangeId,
              attemptId: attempt.attemptId,
              evidenceRevision: attempt.evidenceRevision,
            },
            { id: disclosureEvidenceQueueId(attempt) }
          )
          .pipe(Effect.orDie);
        return "applied" as const;
      })
    );
  }
);

const sleepUntil = Effect.fn(function* (name: string, at: DateTime.Utc) {
  return yield* DateTime.now.pipe(
    Effect.flatMap((now) =>
      DurableClock.sleep({
        name,
        duration: Math.max(0, DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now)),
        inMemoryThreshold: "0 millis",
      })
    )
  );
});

const sendAttempt = Effect.fn(function* (
  exchangeId: PendingConsentExchangeId,
  attemptNumber: DisclosureDeliveryAttemptNumber
) {
  return yield* Activity.make({
    name: `Send/${attemptNumber}`,
    execute: performConsentDisclosureAttempt(exchangeId, attemptNumber),
  });
});

const millisecondsPerSecond = 1_000;
const retryDisclosure = Effect.fn(function* (
  exchangeId: PendingConsentExchangeId,
  attempt: DisclosureDeliveryEvidence,
  expiresAt: DateTime.Utc
) {
  const resumeAt = yield* Activity.make({
    name: `Retry/${attempt.attemptNumber}/${attempt.evidenceRevision}`,
    success: Schema.DateTimeUtc,
    execute: Effect.gen(function* () {
      const failedAt = yield* Effect.fromOption(attempt.failureOccurredAt).pipe(Effect.orDie);
      const base = 2 ** (attempt.attemptNumber - 1) * millisecondsPerSecond;
      const jitter = yield* Random.nextIntBetween(0, base + 1);
      return DateTime.add(failedAt, { milliseconds: base + jitter });
    }),
  });
  yield* DurableDeferred.raceAll({
    name: `RetryWake/${attempt.attemptId}/${attempt.evidenceRevision}`,
    success: Schema.Void,
    error: Schema.Never,
    effects: [
      DurableDeferred.await(disclosureEvidenceChanged(attempt)),
      sleepUntil(`Retry/${attempt.attemptId}/${attempt.evidenceRevision}`, resumeAt),
      sleepUntil("Expiry", expiresAt),
    ],
  });
  const now = yield* DateTime.now;
  if (DateTime.isLessThan(now, resumeAt)) return;
  const { work: current } = yield* readDisclosure(exchangeId).pipe(observeConsentDisclosureResume);
  if (Option.isNone(current) || Option.isNone(current.value.latestAttempt)) return;
  const latest = current.value.latestAttempt.value;
  if (
    latest.attemptId !== attempt.attemptId ||
    latest.evidenceRevision !== attempt.evidenceRevision
  ) {
    return;
  }
  yield* sendAttempt(exchangeId, DisclosureDeliveryAttemptNumber.make(attempt.attemptNumber + 1));
});

const continueDisclosure = Effect.fn(function* (
  exchangeId: PendingConsentExchangeId,
  attempt: DisclosureDeliveryEvidence,
  expiresAt: DateTime.Utc
) {
  // Rejection/exhaustion stops sending, not authenticated reconciliation. A newer provider
  // observation remains admissible until expiry, so completing here would strand late evidence.
  if (attempt.state === "definitively-failed" && attempt.retryable) {
    return yield* retryDisclosure(exchangeId, attempt, expiresAt);
  }
  yield* DurableDeferred.raceAll({
    name: `EvidenceWake/${attempt.attemptId}/${attempt.evidenceRevision}`,
    success: Schema.Void,
    error: Schema.Never,
    effects: [
      DurableDeferred.await(disclosureEvidenceChanged(attempt)),
      sleepUntil("Expiry", expiresAt),
    ],
  });
});

const readDisclosure = Effect.fn(function* (exchangeId: PendingConsentExchangeId) {
  const latest = yield* findConsentDisclosureDeliveryState(exchangeId);
  const work = yield* findConsentDisclosureWork(exchangeId, yield* DateTime.now);
  if (Option.isSome(latest) && latest.value.state === "delivered") {
    yield* recordConsentDisclosureOutcome("delivered");
  } else if (Option.isNone(work)) {
    yield* recordConsentDisclosureOutcome("not-current");
  } else if (Option.isSome(work.value.latestAttempt)) {
    yield* observeEvidence(work.value.latestAttempt.value);
  }
  return { latest, work };
});

const runDisclosure = Effect.fn("WhatsApp.runDisclosure")(function* ({
  exchangeId,
}: {
  readonly exchangeId: PendingConsentExchangeId;
}) {
  while (true) {
    // Do not cache this read in an Activity: every resumption must see newer owner evidence.
    const { latest, work } = yield* readDisclosure(exchangeId).pipe(observeConsentDisclosureResume);
    if (Option.isSome(latest) && latest.value.state === "delivered") {
      return { outcome: "delivered" as const };
    }
    if (Option.isNone(work)) return { outcome: "not-current" as const };
    if (Option.isNone(work.value.latestAttempt)) {
      yield* sendAttempt(exchangeId, DisclosureDeliveryAttemptNumber.make(1));
      continue;
    }
    yield* continueDisclosure(exchangeId, work.value.latestAttempt.value, work.value.expiresAt);
  }
});

/** Registers the slice-owned execution with the one configured engine. */
export const ConsentDisclosureWorkflowLive = ConsentDisclosureWorkflow.toLayer(runDisclosure);

/** Starts one accepted workflow without occupying a consumer while it awaits provider evidence. */
export const startNextConsentDisclosure = Effect.fn("WhatsApp.startNextDisclosure")(function* () {
  const queue = yield* consentDisclosureQueue;
  yield* queue
    .take((payload) =>
      ConsentDisclosureWorkflow.execute(payload, { discard: true }).pipe(
        Effect.asVoid,
        observeConsentDisclosureQueue("start")
      )
    )
    .pipe(
      Effect.catchTags({
        PersistedQueueError: (error) => observeConsentDisclosureQueue(Effect.fail(error), "start"),
        SchemaError: (error) => observeConsentDisclosureQueue(Effect.fail(error), "start"),
      })
    );
});

/** Completes one committed evidence notification outside the evidence transaction. */
export const startNextConsentDisclosureEvidence = Effect.fn("WhatsApp.notifyDisclosureEvidence")(
  function* () {
    const queue = yield* consentDisclosureEvidenceQueue;
    yield* queue
      .take((payload) =>
        Effect.gen(function* () {
          const deferred = disclosureEvidenceChanged(payload);
          const executionId = yield* ConsentDisclosureWorkflow.executionId(payload).pipe(
            Effect.orDie
          );
          yield* DurableDeferred.done(deferred, {
            token: DurableDeferred.tokenFromExecutionId(deferred, {
              workflow: ConsentDisclosureWorkflow,
              executionId,
            }),
            exit: Exit.void,
          });
        }).pipe(observeConsentDisclosureQueue("evidence"))
      )
      .pipe(
        Effect.catchTags({
          PersistedQueueError: (error) =>
            observeConsentDisclosureQueue(Effect.fail(error), "evidence"),
          SchemaError: (error) => observeConsentDisclosureQueue(Effect.fail(error), "evidence"),
        })
      );
  }
);

const superviseDisclosureQueue = <E, R>(
  iteration: Effect.Effect<void, E, R>
): Effect.Effect<never, never, R> =>
  iteration.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause)
        ? Effect.interrupt
        : Effect.sleep("1 second")
    ),
    Effect.forever
  );

/** Production queue handoff and a bounded, paced startup translation of drained legacy requests. */
export const ConsentDisclosureQueueLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
    if (environment !== "production") return;
    const queue = yield* consentDisclosureQueue;
    const publishPage = Effect.fn(function* (after: Option.Option<PendingConsentExchangeId>) {
      const ids = yield* findPendingConsentDisclosureRequests(yield* DateTime.now, after);
      yield* Effect.forEach(
        ids,
        (exchangeId) =>
          queue.offer({ exchangeId, revision: 1 }, { id: exchangeId }).pipe(Effect.orDie),
        { discard: true }
      );
      return Option.fromUndefinedOr(ids.at(-1));
    });
    const first = yield* publishPage(Option.none());
    yield* startNextConsentDisclosure().pipe(superviseDisclosureQueue, Effect.forkScoped);
    yield* startNextConsentDisclosureEvidence().pipe(superviseDisclosureQueue, Effect.forkScoped);
    yield* Effect.gen(function* () {
      let after = first;
      while (Option.isSome(after)) {
        yield* Effect.sleep("1 minute");
        after = yield* publishPage(after);
      }
    }).pipe(Effect.forkScoped);
  })
);
