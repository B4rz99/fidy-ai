import { Crypto, type DateTime, Effect, Encoding, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { PendingConsentExchangeId } from "~/core/consent/model";
import { findPendingConsentDisclosureRetry } from "~/shell/consent/repo";
import {
  DisclosureDeliveryAttemptCapability,
  DisclosureDeliveryAttemptId,
  DisclosureDeliveryAttemptNumber,
  DisclosureDeliveryCorrelationToken,
  DisclosureDeliveryFailureReason,
} from "./disclosure-model";
import { WhatsAppBusinessPhoneNumberId } from "./model";

const DisclosureDeliveryClaimRequest = Schema.Struct({
  ...DisclosureDeliveryAttemptCapability.fields,
  claimedAt: Schema.DateTimeUtcFromDate,
});
const AttemptKey = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  attemptId: DisclosureDeliveryAttemptId,
});
const CorrelationHash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));

const correlationTokenForAttempt = (
  attemptId: DisclosureDeliveryAttemptId
): DisclosureDeliveryCorrelationToken => DisclosureDeliveryCorrelationToken.make(attemptId);

const hashCorrelationToken = Effect.fn(function* (token: DisclosureDeliveryCorrelationToken) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(token))
    .pipe(Effect.orDie);
  return CorrelationHash.make(Encoding.encodeHex(digest));
});

/** Claims one delivery attempt. Only an expired claim that never crossed the provider boundary is reclaimed. */
export const claimConsentDisclosureDelivery = Effect.fn("WhatsApp.claimDisclosureDelivery")(
  function* (exchangeId: PendingConsentExchangeId, claimedAt: DateTime.Utc) {
    const crypto = yield* Crypto.Crypto;
    const attemptId = DisclosureDeliveryAttemptId.make(
      yield* crypto.randomUUIDv4.pipe(Effect.orDie)
    );
    const correlationToken = correlationTokenForAttempt(attemptId);
    const correlationHash = yield* hashCorrelationToken(correlationToken);
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: Schema.Struct({
        ...DisclosureDeliveryClaimRequest.fields,
        correlationHash: CorrelationHash,
      }),
      Result: Schema.Struct({
        attemptId: DisclosureDeliveryAttemptId,
        attemptNumber: DisclosureDeliveryAttemptNumber,
      }),
      execute: (request) => sql`
        SELECT claimed.attempt_id AS "attemptId", claimed.attempt_number AS "attemptNumber"
        FROM fidy_claim_whatsapp_disclosure_delivery(
          ${request.exchangeId}, ${request.attemptId}, ${request.correlationHash},
          ${request.claimedAt}
        ) AS claimed
      `,
    })({ exchangeId, attemptId, correlationToken, correlationHash, claimedAt }).pipe(
      Effect.map(Option.map((claim) => ({ ...claim, correlationToken }))),
      Effect.orDie
    );
  }
);

/** Releases an exact claim that has not crossed the provider boundary. */
export const releaseConsentDisclosureDelivery = Effect.fn("WhatsApp.releaseDisclosureDelivery")(
  function* (input: typeof AttemptKey.Type) {
    const sql = yield* SqlClient.SqlClient;
    yield* SqlSchema.void({
      Request: AttemptKey,
      execute: (request) => sql`
      SELECT fidy_release_whatsapp_disclosure_claim(
        ${request.exchangeId}, ${request.attemptId}
      )
    `,
    })(input).pipe(Effect.orDie);
  }
);

/** Marks the exact attempt as having crossed the provider boundary. */
export const markConsentDisclosureDeliveryStarted = Effect.fn(
  "WhatsApp.markDisclosureDeliveryStarted"
)(function* (
  input: typeof AttemptKey.Type & {
    readonly businessPhoneNumberId: WhatsAppBusinessPhoneNumberId;
  },
  startedAt: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* SqlSchema.findOne({
    Request: Schema.Struct({
      ...AttemptKey.fields,
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
      startedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: Schema.Struct({ applied: Schema.Boolean }),
    execute: (request) => sql`
        SELECT fidy_mark_whatsapp_disclosure_attempt_started(
          ${request.exchangeId}, ${request.attemptId}, ${request.businessPhoneNumberId},
          ${request.startedAt}
        ) AS applied
      `,
  })({ ...input, startedAt }).pipe(Effect.orDie)).applied;
});

const AcceptedAttemptRequest = Schema.Struct({
  ...DisclosureDeliveryAttemptCapability.fields,
  message: ProviderMessageEvidence,
  acceptedAt: Schema.DateTimeUtcFromDate,
});

/** Retains provider acceptance as nonterminal evidence requiring delivery reconciliation. */
export const recordConsentDisclosureAttemptAccepted = Effect.fn(
  "WhatsApp.recordDisclosureAttemptAccepted"
)(function* (input: typeof AcceptedAttemptRequest.Type) {
  const correlationHash = yield* hashCorrelationToken(input.correlationToken);
  const sql = yield* SqlClient.SqlClient;
  return (yield* SqlSchema.findOne({
    Request: Schema.Struct({ ...AcceptedAttemptRequest.fields, correlationHash: CorrelationHash }),
    Result: Schema.Struct({ applied: Schema.Boolean }),
    execute: (request) => sql`
        SELECT fidy_record_whatsapp_disclosure_attempt_accepted(
          ${request.exchangeId}, ${request.attemptId}, ${request.correlationHash},
          ${request.message.providerMessageId}, ${request.acceptedAt}
        ) AS applied
      `,
  })({ ...input, correlationHash }).pipe(Effect.orDie)).applied;
});

const SentAttemptRequest = Schema.Struct({
  ...DisclosureDeliveryAttemptCapability.fields,
  message: ProviderMessageEvidence,
  occurredAt: Schema.DateTimeUtcFromDate,
});

/** Retains authenticated nonterminal sent evidence without advancing Consent. */
export const recordConsentDisclosureAttemptSent = Effect.fn("WhatsApp.recordDisclosureAttemptSent")(
  function* (input: typeof SentAttemptRequest.Type) {
    const correlationHash = yield* hashCorrelationToken(input.correlationToken);
    const sql = yield* SqlClient.SqlClient;
    return (yield* SqlSchema.findOne({
      Request: Schema.Struct({ ...SentAttemptRequest.fields, correlationHash: CorrelationHash }),
      Result: Schema.Struct({ applied: Schema.Boolean }),
      execute: (request) => sql`
        SELECT fidy_record_whatsapp_disclosure_attempt_sent(
          ${request.exchangeId}, ${request.attemptId}, ${request.correlationHash},
          ${request.message.providerMessageId}, ${request.occurredAt}
        ) AS applied
      `,
    })({ ...input, correlationHash }).pipe(Effect.orDie)).applied;
  }
);

const DeliveredAttemptRequest = Schema.Struct({
  ...DisclosureDeliveryAttemptCapability.fields,
  message: ProviderMessageEvidence,
  deliveredAt: Schema.DateTimeUtcFromDate,
});

/** Retains provider-qualified acceptance on the exact WhatsApp attempt. */
export const recordConsentDisclosureAttemptDelivered = Effect.fn(
  "WhatsApp.recordDisclosureAttemptDelivered"
)(function* (input: typeof DeliveredAttemptRequest.Type) {
  const correlationHash = yield* hashCorrelationToken(input.correlationToken);
  const sql = yield* SqlClient.SqlClient;
  return (yield* SqlSchema.findOne({
    Request: Schema.Struct({ ...DeliveredAttemptRequest.fields, correlationHash: CorrelationHash }),
    Result: Schema.Struct({ applied: Schema.Boolean }),
    execute: (request) => sql`
        SELECT fidy_record_whatsapp_disclosure_attempt_delivered(
          ${request.exchangeId}, ${request.attemptId}, ${request.correlationHash},
          ${request.message.providerMessageId}, ${request.deliveredAt}
        ) AS applied
      `,
  })({ ...input, correlationHash }).pipe(Effect.orDie)).applied;
});

const FailedRequest = Schema.Struct({
  ...DisclosureDeliveryAttemptCapability.fields,
  reason: DisclosureDeliveryFailureReason,
  attemptNumber: DisclosureDeliveryAttemptNumber,
  certainty: Schema.Literals(["rejected", "ambiguous"]),
  occurredAt: Schema.DateTimeUtcFromDate,
  providerEvidence: Schema.Boolean,
  retryAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
});

/** Persists bounded failure evidence; only definitive rejection can schedule another provider call. */
export const recordConsentDisclosureDeliveryFailure = Effect.fn(
  "WhatsApp.recordDisclosureDeliveryFailure"
)(function* (input: typeof FailedRequest.Type) {
  const correlationHash = yield* hashCorrelationToken(input.correlationToken);
  const sql = yield* SqlClient.SqlClient;
  return (yield* SqlSchema.findOne({
    Request: Schema.Struct({ ...FailedRequest.fields, correlationHash: CorrelationHash }),
    Result: Schema.Struct({ applied: Schema.Boolean }),
    execute: (request) => sql`
        SELECT fidy_record_whatsapp_disclosure_attempt_failure(
          ${request.exchangeId}, ${request.attemptId}, ${request.correlationHash},
          ${request.reason}, ${request.certainty}, ${request.occurredAt},
          ${request.providerEvidence}, ${request.retryAt}
        ) AS applied
      `,
  })({ ...input, correlationHash }).pipe(Effect.orDie)).applied;
});

const DueRetryAttempt = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  attemptId: DisclosureDeliveryAttemptId,
  attemptNumber: DisclosureDeliveryAttemptNumber,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
});
const RetryAttemptClaim = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  attemptId: DisclosureDeliveryAttemptId,
  correlationToken: DisclosureDeliveryCorrelationToken,
  attemptNumber: DisclosureDeliveryAttemptNumber,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
});

const findDueConsentDisclosureRetry = Effect.fn(function* (claimedAt: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.DateTimeUtcFromDate,
    Result: DueRetryAttempt,
    execute: (now) => sql`
        SELECT exchange_id AS "exchangeId", attempt_id AS "attemptId",
          attempt_number AS "attemptNumber", business_phone_number_id AS "businessPhoneNumberId"
        FROM fidy_find_due_whatsapp_disclosure_retry(${now})
      `,
  })(claimedAt).pipe(Effect.orDie);
});

const insertConsentDisclosureRetry = Effect.fn(function* (input: {
  readonly previousAttemptId: DisclosureDeliveryAttemptId;
  readonly attemptId: DisclosureDeliveryAttemptId;
  readonly correlationToken: DisclosureDeliveryCorrelationToken;
  readonly claimedAt: DateTime.Utc;
}) {
  const correlationHash = yield* hashCorrelationToken(input.correlationToken);
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      previousAttemptId: DisclosureDeliveryAttemptId,
      attemptId: DisclosureDeliveryAttemptId,
      correlationToken: DisclosureDeliveryCorrelationToken,
      correlationHash: CorrelationHash,
      claimedAt: Schema.DateTimeUtcFromDate,
    }),
    Result: RetryAttemptClaim,
    execute: (request) => sql`
      SELECT claimed.exchange_id AS "exchangeId", ${request.attemptId} AS "attemptId",
        ${request.correlationToken} AS "correlationToken",
        claimed.attempt_number AS "attemptNumber",
        claimed.business_phone_number_id AS "businessPhoneNumberId"
      FROM fidy_claim_whatsapp_disclosure_retry(
        ${request.previousAttemptId}, ${request.attemptId}, ${request.correlationHash},
        ${request.claimedAt}
      ) AS claimed
    `,
  })({ ...input, correlationHash }).pipe(Effect.orDie);
});

/** Claims one due retry with SKIP LOCKED and retires the definitively failed predecessor. */
export const claimNextConsentDisclosureRetry = Effect.fn("WhatsApp.claimNextDisclosureRetry")(
  function* (claimedAt: DateTime.Utc) {
    const crypto = yield* Crypto.Crypto;
    const attemptId = DisclosureDeliveryAttemptId.make(
      yield* crypto.randomUUIDv4.pipe(Effect.orDie)
    );
    const correlationToken = correlationTokenForAttempt(attemptId);
    const sql = yield* SqlClient.SqlClient;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const due = yield* findDueConsentDisclosureRetry(claimedAt);
          if (Option.isNone(due)) return Option.none();
          const disclosure = yield* findPendingConsentDisclosureRetry(due.value.exchangeId);
          if (Option.isNone(disclosure)) return Option.none();
          const claimed = yield* insertConsentDisclosureRetry({
            previousAttemptId: due.value.attemptId,
            attemptId,
            correlationToken,
            claimedAt,
          });
          return Option.map(claimed, (retry) => ({ ...retry, ...disclosure.value }));
        })
      )
      .pipe(Effect.orDie);
  }
);

const CorrelatedAttemptRow = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  attemptId: DisclosureDeliveryAttemptId,
  attemptNumber: DisclosureDeliveryAttemptNumber,
  state: Schema.Literals([
    "started",
    "reconciliation-required",
    "retry-scheduled",
    "definitively-failed",
  ]),
});

/** Resolves an opaque provider callback without consulting recipient identity evidence. */
export const findConsentDisclosureAttemptByCorrelation = Effect.fn(
  "WhatsApp.findDisclosureAttemptByCorrelation"
)(function* (correlationToken: DisclosureDeliveryCorrelationToken) {
  const correlationHash = yield* hashCorrelationToken(correlationToken);
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: CorrelationHash,
    Result: CorrelatedAttemptRow,
    execute: (token) => sql`
      SELECT correlated.exchange_id AS "exchangeId", correlated.attempt_id AS "attemptId",
        correlated.attempt_number AS "attemptNumber", correlated.state
      FROM fidy_find_whatsapp_disclosure_attempt_by_correlation(${token}) AS correlated
    `,
  })(correlationHash).pipe(Effect.orDie);
});

const DeliveryStateRow = Schema.Struct({
  attemptId: DisclosureDeliveryAttemptId,
  state: Schema.Literals([
    "claimed",
    "started",
    "reconciliation-required",
    "retry-scheduled",
    "delivered",
    "definitively-failed",
    "retry-exhausted",
  ]),
  reason: Schema.OptionFromNullOr(DisclosureDeliveryFailureReason),
  attemptNumber: DisclosureDeliveryAttemptNumber,
});

/** Safe operational projection; it contains no recipient or message content. */
export const findConsentDisclosureDeliveryState = Effect.fn("WhatsApp.findDisclosureDeliveryState")(
  function* (exchangeId: PendingConsentExchangeId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: PendingConsentExchangeId,
      Result: DeliveryStateRow,
      execute: (id) => sql`
        SELECT attempt.attempt_id AS "attemptId", attempt.state,
          attempt.reason, attempt.attempt_number AS "attemptNumber"
        FROM fidy_find_whatsapp_disclosure_delivery_state(${id}) AS attempt
      `,
    })(exchangeId).pipe(Effect.orDie);
  }
);
