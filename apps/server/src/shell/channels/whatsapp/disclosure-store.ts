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
  DisclosureDeliveryEvidence,
  DisclosureDeliveryFailureReason,
  DisclosureDeliveryState,
  DisclosureEvidenceRevision,
} from "./disclosure-model";
import { E164PhoneNumber } from "~/core/identity/reference";
import { WhatsAppBusinessPhoneNumberId } from "./model";

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
  message: Schema.Option(ProviderMessageEvidence),
  retryable: Schema.Boolean,
});

/** Persists provider certainty and retryability, never an execution schedule. */
export const recordConsentDisclosureDeliveryFailure = Effect.fn(
  "WhatsApp.recordDisclosureDeliveryFailure"
)(function* (input: typeof FailedRequest.Type) {
  const correlationHash = yield* hashCorrelationToken(input.correlationToken);
  const sql = yield* SqlClient.SqlClient;
  return (yield* SqlSchema.findOne({
    Request: Schema.Struct({
      ...FailedRequest.fields,
      correlationHash: CorrelationHash,
      providerMessageId: Schema.OptionFromNullOr(ProviderMessageEvidence.fields.providerMessageId),
    }),
    Result: Schema.Struct({ applied: Schema.Boolean }),
    execute: (request) => sql`
        SELECT fidy_record_whatsapp_disclosure_attempt_failure(
          ${request.exchangeId}, ${request.attemptId}, ${request.correlationHash},
          ${request.reason}, ${request.certainty}, ${request.occurredAt},
          ${request.providerEvidence}, ${request.retryable}, ${request.providerMessageId}
        ) AS applied
      `,
  })({
    ...input,
    correlationHash,
    providerMessageId: Option.map(input.message, (message) => message.providerMessageId),
  }).pipe(Effect.orDie)).applied;
});

/** Resolves an opaque provider callback without consulting recipient identity evidence. */
export const findConsentDisclosureAttemptByCorrelation = Effect.fn(
  "WhatsApp.findDisclosureAttemptByCorrelation"
)(function* (correlationToken: DisclosureDeliveryCorrelationToken) {
  const correlationHash = yield* hashCorrelationToken(correlationToken);
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: CorrelationHash,
    Result: CorrelatedAttempt,
    execute: (token) => sql`
      SELECT correlated.exchange_id AS "exchangeId", correlated.attempt_id AS "attemptId",
        correlated.attempt_number AS "attemptNumber", correlated.state,
        correlated.evidence_revision AS "evidenceRevision"
      FROM fidy_find_whatsapp_disclosure_attempt_by_correlation(${token}) AS correlated
    `,
  })(correlationHash).pipe(Effect.orDie);
});

/** Safe operational projection; it contains no recipient or message content. */
export const findConsentDisclosureDeliveryState = Effect.fn("WhatsApp.findDisclosureDeliveryState")(
  function* (exchangeId: PendingConsentExchangeId) {
    const sql = yield* SqlClient.SqlClient;
    return yield* SqlSchema.findOneOption({
      Request: PendingConsentExchangeId,
      Result: DisclosureDeliveryEvidence,
      execute: (id) => sql`
        SELECT attempt.attempt_id AS "attemptId", attempt.state,
          attempt.reason, attempt.attempt_number AS "attemptNumber", attempt.retryable,
          attempt.failure_occurred_at AS "failureOccurredAt",
          attempt.evidence_revision AS "evidenceRevision"
        FROM fidy_find_whatsapp_disclosure_delivery_state(${id}) AS attempt
      `,
    })(exchangeId).pipe(Effect.orDie);
  }
);

const CorrelatedAttempt = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  attemptId: DisclosureDeliveryAttemptId,
  attemptNumber: DisclosureDeliveryAttemptNumber,
  state: DisclosureDeliveryState,
  evidenceRevision: DisclosureEvidenceRevision,
});

/** Serializes short read/settle/wake work with callbacks and arming. Never run provider work here. */
export const lockConsentDisclosure = Effect.fn("WhatsApp.lockDisclosure")(function* <A, E, R>(
  exchangeId: PendingConsentExchangeId,
  effect: Effect.Effect<A, E, R>
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`SELECT fidy_lock_whatsapp_disclosure(${exchangeId})`.pipe(Effect.orDie);
      return yield* effect;
    })
  );
});

const DeliveryRequest = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
  sandboxPhone: Schema.OptionFromNullOr(E164PhoneNumber),
  now: Schema.DateTimeUtcFromDate,
});

/** Retains the first routing request for a current exchange; replay never changes its destination. */
export const requestConsentDisclosure = Effect.fn("WhatsApp.requestDisclosure")(function* (
  input: typeof DeliveryRequest.Type
) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* SqlSchema.findOne({
    Request: DeliveryRequest,
    Result: Schema.Struct({ eligible: Schema.Boolean }),
    execute: (request) => sql`SELECT fidy_request_whatsapp_disclosure(
        ${request.exchangeId}, ${request.businessPhoneNumberId}, ${request.sandboxPhone}, ${request.now}
      ) AS eligible`,
  })(input).pipe(Effect.orDie)).eligible;
});

/** Loads private routing and the Consent owner's current disclosure, never a send capability. */
export const findConsentDisclosureWork = Effect.fn("WhatsApp.findDisclosureWork")(function* (
  exchangeId: PendingConsentExchangeId,
  now: DateTime.Utc
) {
  const sql = yield* SqlClient.SqlClient;
  const routing = yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      exchangeId: PendingConsentExchangeId,
      now: Schema.DateTimeUtcFromDate,
    }),
    Result: Schema.Struct({
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId,
      sandboxPhone: Schema.OptionFromNullOr(E164PhoneNumber),
    }),
    execute: (request) => sql`SELECT business_phone_number_id AS "businessPhoneNumberId",
        sandbox_phone AS "sandboxPhone" FROM fidy_find_whatsapp_disclosure_request(${request.exchangeId}, ${request.now})`,
  })({ exchangeId, now }).pipe(Effect.orDie);
  if (Option.isNone(routing)) return Option.none();
  const disclosure = yield* findPendingConsentDisclosureRetry(exchangeId);
  if (Option.isNone(disclosure)) return Option.none();
  const latestAttempt = yield* findConsentDisclosureDeliveryState(exchangeId);
  return Option.some({ ...routing.value, ...disclosure.value, latestAttempt });
});

/** Arms exactly the next safe ordinal once. An armed or ambiguous attempt is never replayable. */
export const armConsentDisclosureAttempt = Effect.fn("WhatsApp.armDisclosureAttempt")(function* (
  exchangeId: PendingConsentExchangeId,
  attemptNumber: DisclosureDeliveryAttemptNumber,
  now: DateTime.Utc
) {
  const crypto = yield* Crypto.Crypto;
  const attemptId = DisclosureDeliveryAttemptId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
  const correlationToken = correlationTokenForAttempt(attemptId);
  const correlationHash = yield* hashCorrelationToken(correlationToken);
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: Schema.Struct({
      exchangeId: PendingConsentExchangeId,
      attemptId: DisclosureDeliveryAttemptId,
      attemptNumber: DisclosureDeliveryAttemptNumber,
      correlationHash: CorrelationHash,
      now: Schema.DateTimeUtcFromDate,
    }),
    Result: Schema.Struct({
      attemptId: DisclosureDeliveryAttemptId,
      attemptNumber: DisclosureDeliveryAttemptNumber,
    }),
    execute: (request) => sql`SELECT attempt_id AS "attemptId", attempt_number AS "attemptNumber"
        FROM fidy_arm_whatsapp_disclosure_attempt(${request.exchangeId}, ${request.attemptId}, ${request.correlationHash}, ${request.attemptNumber}, ${request.now})`,
  })({ exchangeId, attemptId, attemptNumber, correlationHash, now }).pipe(
    Effect.map(Option.map((attempt) => ({ ...attempt, correlationToken }))),
    Effect.orDie
  );
});

/** Discovers at most 100 current requests after an exclusive UUID cursor for startup publication. */
export const findPendingConsentDisclosureRequests = Effect.fn(
  "WhatsApp.findPendingDisclosureRequests"
)(function* (now: DateTime.Utc, after: Option.Option<PendingConsentExchangeId>) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findAll({
    Request: Schema.Struct({
      now: Schema.DateTimeUtcFromDate,
      after: Schema.OptionFromNullOr(PendingConsentExchangeId),
    }),
    Result: Schema.Struct({ exchangeId: PendingConsentExchangeId }),
    execute: (request) =>
      sql`SELECT exchange_id AS "exchangeId" FROM fidy_find_pending_whatsapp_disclosure_requests(${request.now}, ${request.after})`,
  })({ now, after }).pipe(
    Effect.map((rows): ReadonlyArray<PendingConsentExchangeId> =>
      rows.map((row) => row.exchangeId)
    ),
    Effect.orDie
  );
});

/** Bounded retention discovery includes requests whose Consent owner has already removed the exchange. */
export const findExpiredConsentDisclosureRequests = Effect.fn(
  "WhatsApp.findExpiredDisclosureRequests"
)(function* (now: DateTime.Utc) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findAll({
    Request: Schema.DateTimeUtcFromDate,
    Result: Schema.Struct({ exchangeId: PendingConsentExchangeId }),
    execute: (at) =>
      sql`SELECT exchange_id AS "exchangeId" FROM fidy_find_expired_whatsapp_disclosure_requests(${at})`,
  })(now).pipe(
    Effect.map((rows): ReadonlyArray<PendingConsentExchangeId> =>
      rows.map((row) => row.exchangeId)
    ),
    Effect.orDie
  );
});

/** Removes retained routing and evidence only after the caller proves durable execution terminal and clears it. */
export const removeConsentDisclosureRequest = Effect.fn("WhatsApp.removeDisclosureRequest")(
  function* (exchangeId: PendingConsentExchangeId) {
    const sql = yield* SqlClient.SqlClient;
    yield* SqlSchema.void({
      Request: PendingConsentExchangeId,
      execute: (id) => sql`SELECT fidy_remove_whatsapp_disclosure_request(${id})`,
    })(exchangeId).pipe(Effect.orDie);
  }
);
