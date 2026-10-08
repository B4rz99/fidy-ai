import { admitResource, releaseOutstandingResource } from "../../../resource-admission/operations";
import { EmailAddress } from "../../../../src/core/email-authentication/contract";
import {
  ConsentIngressExchange,
  type ConsentIngressMessage,
  DisclosureDeliveryCorrelationToken,
  type DisclosureSnapshot,
  type EmailStatus,
  PendingConsentExchangeId,
  PendingDisclosureJson,
  Sha256Digest,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  type WhatsAppInboundEvent,
  WhatsAppProviderMessageId,
  type WhatsAppSendFailed,
  type WhatsAppSentMessage,
  maxWhatsAppFutureTimestampMinutes,
} from "../../../../src/shell/consent/contract";
import {
  canRecordConsentIngressDecision,
  classifyConsentIngressReplay,
  currentDisclosureFor,
  decideConsentReply,
  isConsentIngressDecisionPhase,
} from "../../../../src/shell/consent/operations";
import { Clock, Crypto, DateTime, Duration, Effect, Exit, Option, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  type ResourceAdmissionAuthorityConfig,
  ResourceAdmissionCharges,
  type ResourceAdmissionCharges as ResourceAdmissionChargesType,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionRefused,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../../../resource-admission/contract";
import { type WhatsAppAuthenticatedInbound as WebhookInbound } from "../../../whatsapp/contract";
import { expireVoiceRefusals } from "../../../whatsapp/operations";
import { type ConsentDeliveryInput, type ConsentIngressEnvironment } from "../contract";

export type DisclosureSender = (
  request: Readonly<{
    caller: WhatsAppInboundEvent["caller"];
    phoneNumberId: WhatsAppBusinessPhoneNumberId;
    disclosure: DisclosureSnapshot;
    correlationToken: DisclosureDeliveryCorrelationToken;
  }>
) => Effect.Effect<WhatsAppSentMessage, WhatsAppSendFailed>;

type EmailStatusSender = (
  request: Readonly<{
    caller: WhatsAppInboundEvent["caller"];
    phoneNumberId: WhatsAppBusinessPhoneNumberId;
    status: EmailStatus;
  }>
) => Effect.Effect<WhatsAppSentMessage, WhatsAppSendFailed>;

type Environment = Pick<ConsentIngressEnvironment, "DB" | "onAccepted"> &
  Readonly<{
    delivery: Option.Option<
      Readonly<{
        sendDisclosure: DisclosureSender;
        sendEmailStatus: EmailStatusSender;
      }>
    >;
  }>;

type StoredExchange = typeof PendingExchangeRow.Type & {
  readonly lifecycle: ConsentIngressExchange;
};

const dayMs = 86_400_000;
// Initiation must become ineligible before its receipt-based exchange expires, even
// when Kapso's signed event clock leads our receipt clock by its full tolerance.
export const maxKapsoFutureSkewMs = Duration.toMillis(
  Duration.minutes(maxWhatsAppFutureTimestampMinutes)
);
const hourMs = 3_600_000;
const maximumHourlyDisclosures = 500;
const expiredExchangeSweepLimit = 32;
const scheduledExchangeSweepLimit = 128;
export const HTTP_OK = 200;
export const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const oneUnit = ResourceAdmissionUnits.make(1);
const policies = ResourceAdmissionPolicies.make([
  {
    kind: "rolling_window",
    dimension: "source",
    key: ResourceAdmissionPolicyKey.make("consent.source.v1"),
    durationMs: ResourceAdmissionDurationMs.make(dayMs),
    limit: ResourceAdmissionLimit.make(3),
  },
  {
    kind: "rolling_window",
    dimension: "operation",
    key: ResourceAdmissionPolicyKey.make("consent.global.v1"),
    durationMs: ResourceAdmissionDurationMs.make(hourMs),
    limit: ResourceAdmissionLimit.make(maximumHourlyDisclosures),
  },
  {
    kind: "rolling_window",
    dimension: "spend",
    key: ResourceAdmissionPolicyKey.make("consent.kapso.v1"),
    durationMs: ResourceAdmissionDurationMs.make(hourMs),
    limit: ResourceAdmissionLimit.make(maximumHourlyDisclosures),
  },
  {
    kind: "outstanding",
    dimension: "outstanding_work",
    key: ResourceAdmissionPolicyKey.make("consent.pending.v1"),
    leaseMs: ResourceAdmissionDurationMs.make(dayMs),
    limit: ResourceAdmissionLimit.make(maximumHourlyDisclosures),
  },
]);
const admission = (db: D1Database, now: number): ResourceAdmissionAuthorityConfig => ({
  database: db,
  nowEpochMs: () => ResourceAdmissionEpochMs.make(now),
  policies,
});
const consentCharges = (source: string): ResourceAdmissionChargesType =>
  ResourceAdmissionCharges.make([
    {
      policyKey: ResourceAdmissionPolicyKey.make("consent.source.v1"),
      scopeKey: ResourceAdmissionScopeKey.make(source),
      units: oneUnit,
    },
    {
      policyKey: ResourceAdmissionPolicyKey.make("consent.global.v1"),
      scopeKey: ResourceAdmissionScopeKey.make("all"),
      units: oneUnit,
    },
    {
      policyKey: ResourceAdmissionPolicyKey.make("consent.kapso.v1"),
      scopeKey: ResourceAdmissionScopeKey.make("kapso"),
      units: oneUnit,
    },
    {
      policyKey: ResourceAdmissionPolicyKey.make("consent.pending.v1"),
      scopeKey: ResourceAdmissionScopeKey.make("all"),
      units: oneUnit,
    },
  ]);
const PendingExchangeRow = Schema.Struct({
  id: PendingConsentExchangeId,
  portfolio_id: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  phone_number_id: WhatsAppBusinessPhoneNumberId,
  disclosure_json: Schema.String,
  disclosure_message_id: Schema.NullOr(WhatsAppProviderMessageId),
  correlation_token: DisclosureDeliveryCorrelationToken,
  created_at_ms: Schema.Finite,
  disclosed_at_ms: Schema.NullOr(Schema.Finite),
  decision_not_before_ms: Schema.NullOr(Schema.Finite),
  expires_at_ms: Schema.Finite,
  initiating_message_id: WhatsAppProviderMessageId,
  initiating_body_sha256: Sha256Digest,
  email_preaccept_latest_occurred_ms: Schema.NullOr(Schema.Finite),
  state: Schema.Literals([
    "awaiting_delivery",
    "outbound_started",
    "awaiting_decision",
    "accepted",
    "declined",
  ]),
});
const DecisionRow = Schema.Struct({
  decision_message_id: WhatsAppProviderMessageId,
  body_sha256: Sha256Digest,
  decision: Schema.Literals(["accepted", "declined"]),
});
const DeliveryRow = Schema.Struct({
  message_id: WhatsAppProviderMessageId,
  phone_number_id: WhatsAppBusinessPhoneNumberId,
  occurred_at_ms: Schema.Finite,
});

type Inbound = WebhookInbound &
  Readonly<{
    event: WhatsAppInboundEvent & {
      content: Extract<WhatsAppInboundEvent["content"], { _tag: "Text" }>;
    };
  }>;
export const answer = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

/** Keep foreign I/O failures distinct from an absent result; the ingress maps them to 503. */
export const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

const beforeDeliveryState = (
  state: typeof PendingExchangeRow.Type.state
): state is "awaiting_delivery" | "outbound_started" =>
  state === "awaiting_delivery" || state === "outbound_started";

const afterDeliveryState = (
  state: typeof PendingExchangeRow.Type.state
): state is "awaiting_decision" | "accepted" | "declined" =>
  state === "awaiting_decision" || state === "accepted" || state === "declined";

const hasNoDelivery = (row: typeof PendingExchangeRow.Type): boolean =>
  row.disclosed_at_ms === null && row.decision_not_before_ms === null;

/** Reconcile D1's flat row with the server-owned lifecycle before any domain decision. */
const reconcileExchange = (
  row: typeof PendingExchangeRow.Type
): Effect.Effect<StoredExchange, void> => {
  const base = {
    initiatingMessageId: row.initiating_message_id,
    initiatingBodySha256: row.initiating_body_sha256,
    businessPhoneNumberId: row.phone_number_id,
    expiresAtMs: row.expires_at_ms,
  };
  const delivered =
    row.disclosed_at_ms !== null &&
    row.decision_not_before_ms !== null &&
    row.disclosure_message_id !== null;
  if (beforeDeliveryState(row.state) && hasNoDelivery(row)) {
    return Schema.decodeEffect(ConsentIngressExchange)({
      ...base,
      phase: {
        _tag: "BeforeDelivery",
        stage: row.state,
        disclosureMessageId: row.disclosure_message_id,
      },
    }).pipe(
      Effect.map((lifecycle) => ({ ...row, lifecycle })),
      Effect.mapError(() => undefined)
    );
  }
  if (delivered && afterDeliveryState(row.state)) {
    const phase =
      row.state === "awaiting_decision"
        ? {
            _tag: "AwaitingDecision" as const,
            disclosureMessageId: row.disclosure_message_id,
            disclosedAtMs: row.disclosed_at_ms,
            decisionNotBeforeMs: row.decision_not_before_ms,
          }
        : {
            _tag: "Settled" as const,
            decision: row.state,
            disclosureMessageId: row.disclosure_message_id,
            disclosedAtMs: row.disclosed_at_ms,
            decisionNotBeforeMs: row.decision_not_before_ms,
          };
    return Schema.decodeEffect(ConsentIngressExchange)({ ...base, phase }).pipe(
      Effect.map((lifecycle) => ({ ...row, lifecycle })),
      Effect.mapError(() => undefined)
    );
  }
  return Effect.fail(undefined);
};

const ingressMessage = (input: Inbound): ConsentIngressMessage => ({
  providerMessageId: input.event.messageEvidence.providerMessageId,
  bodySha256: input.digest,
  businessPhoneNumberId: input.event.businessPhoneNumberId,
  occurredAtMs: DateTime.toEpochMillis(input.event.occurredAt),
  receivedAtMs: input.receivedAtMs,
});

const findExchange = (
  db: D1Database,
  event: WhatsAppInboundEvent
): Effect.Effect<Option.Option<StoredExchange>, void> =>
  attempt(() =>
    db
      .prepare(`SELECT id, portfolio_id, bsuid, phone_number_id, disclosure_json, disclosure_message_id,
    correlation_token, created_at_ms, disclosed_at_ms, decision_not_before_ms, expires_at_ms, state,
    initiating_message_id, initiating_body_sha256, email_preaccept_latest_occurred_ms
    FROM pending_consent_exchanges
    WHERE portfolio_id = ? AND bsuid = ? ORDER BY created_at_ms DESC LIMIT 1`)
      .bind(event.caller.businessPortfolioId, event.caller.businessScopedUserId)
      .first()
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.succeedNone
        : Schema.decodeUnknownEffect(PendingExchangeRow)(row).pipe(
            Effect.flatMap(reconcileExchange),
            Effect.asSome,
            Effect.mapError(() => undefined)
          )
    )
  );

const findRecordedDecision = (
  db: D1Database,
  input: Inbound
): Effect.Effect<Option.Option<Response>, void> =>
  attempt(() =>
    db
      .prepare(`SELECT decision_message_id, body_sha256, decision
    FROM pending_consent_decisions WHERE portfolio_id = ? AND decision_message_id = ?`)
      .bind(input.event.caller.businessPortfolioId, input.event.messageEvidence.providerMessageId)
      .first()
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.succeedNone
        : Schema.decodeUnknownEffect(DecisionRow)(row).pipe(
            Effect.asSome,
            Effect.mapError(() => undefined)
          )
    ),
    Effect.map((decoded) =>
      Option.map(decoded, (row) =>
        answer(row.body_sha256 === input.digest ? HTTP_OK : HTTP_CONFLICT)
      )
    )
  );

const persistDecision = ({
  db,
  input,
  pending,
  decision,
}: Readonly<{
  db: D1Database;
  input: Inbound;
  pending: typeof PendingExchangeRow.Type;
  decision: "accepted" | "declined";
}>): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const statement = db
      .prepare(`INSERT INTO pending_consent_decisions
      (exchange_id, portfolio_id, bsuid, phone_number_id, decision, disclosure_json, disclosure_message_id,
       decision_message_id, delivery_key, body_sha256, occurred_at_ms, received_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        pending.id,
        input.event.caller.businessPortfolioId,
        input.event.caller.businessScopedUserId,
        input.event.businessPhoneNumberId,
        decision,
        pending.disclosure_json,
        pending.disclosure_message_id,
        input.event.messageEvidence.providerMessageId,
        input.deliveryKey,
        input.digest,
        DateTime.toEpochMillis(input.event.occurredAt),
        input.receivedAtMs
      );
    const committed = yield* Effect.exit(
      releaseOutstandingResource(admission(db, input.receivedAtMs), {
        grantId: ResourceAdmissionGrantId.make(pending.id),
        statements: [statement],
      })
    );
    if (Exit.isSuccess(committed)) return answer(HTTP_OK);
    const latest = yield* findExchange(db, input.event);
    return answer(
      Option.isSome(latest) && latest.value.state !== "awaiting_decision"
        ? HTTP_CONFLICT
        : HTTP_UNAVAILABLE
    );
  }).pipe(
    Effect.catchCause(() =>
      Effect.map(findRecordedDecision(db, input), (replay) =>
        Option.getOrElse(replay, () => answer(HTTP_CONFLICT))
      )
    )
  );

const validDisclosure = (json: string): boolean =>
  Option.isSome(Schema.decodeOption(PendingDisclosureJson)(json));

const recordPrematureMailbox = (
  db: D1Database,
  input: Inbound,
  exchangeId: PendingConsentExchangeId
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    if (Option.isNone(Schema.decodeOption(EmailAddress)(input.event.content.text))) {
      return answer(HTTP_OK);
    }
    const recorded = yield* attempt(() =>
      db
        .prepare(`UPDATE pending_consent_exchanges
        SET email_preaccept_latest_occurred_ms = MAX(
          COALESCE(email_preaccept_latest_occurred_ms, 0), ?)
        WHERE id = ? AND state IN ('awaiting_delivery', 'outbound_started', 'awaiting_decision')`)
        .bind(DateTime.toEpochMillis(input.event.occurredAt), exchangeId)
        .run()
    );
    return answer(recorded.meta.changes === 1 ? HTTP_OK : HTTP_CONFLICT);
  });

const recordDecision = (db: D1Database, input: Inbound): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const replay = yield* findRecordedDecision(db, input);
    if (Option.isSome(replay)) return replay.value;
    const choice = yield* decideConsentReply({ _tag: "Text", text: input.event.content.text });
    const decision = choice._tag === "Accepted" ? "accepted" : "declined";
    const pending = yield* findExchange(db, input.event);
    if (
      Option.isNone(pending) ||
      !canRecordConsentIngressDecision({
        exchange: pending.value.lifecycle,
        message: ingressMessage(input),
      })
    ) {
      return answer(HTTP_CONFLICT);
    }
    if (!validDisclosure(pending.value.disclosure_json)) return answer(HTTP_UNAVAILABLE);
    if (choice._tag === "Clarify") {
      return yield* recordPrematureMailbox(db, input, pending.value.id);
    }
    return yield* persistDecision({ db, input, pending: pending.value, decision });
  });

export const sameDelivery = ({
  row,
  input,
}: Readonly<{
  row: typeof DeliveryRow.Type;
  input: Pick<ConsentDeliveryInput, "messageId" | "phoneNumberId" | "occurredAtMs">;
}>): boolean =>
  row.message_id === input.messageId &&
  row.phone_number_id === input.phoneNumberId &&
  row.occurred_at_ms === input.occurredAtMs;

export const findDelivery = ({
  db,
  token,
}: Readonly<{ db: D1Database; token: DisclosureDeliveryCorrelationToken }>): Effect.Effect<
  Option.Option<typeof DeliveryRow.Type>,
  void
> =>
  attempt(() =>
    db
      .prepare(
        "SELECT message_id, phone_number_id, occurred_at_ms FROM pending_consent_delivery WHERE correlation_token = ?"
      )
      .bind(token)
      .first()
  ).pipe(
    Effect.flatMap((row) =>
      row === null
        ? Effect.succeedNone
        : Schema.decodeUnknownEffect(DeliveryRow)(row).pipe(
            Effect.asSome,
            Effect.mapError(() => undefined)
          )
    )
  );

type NewExchange = Readonly<{
  input: Inbound;
  id: PendingConsentExchangeId;
  correlationToken: DisclosureDeliveryCorrelationToken;
  disclosure: ReturnType<typeof currentDisclosureFor>;
}>;

const exchangeStatement = (
  db: D1Database,
  { input, id, correlationToken }: NewExchange,
  disclosureJson: string
): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO pending_consent_exchanges
    (id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256,
     correlation_token, disclosure_json, created_at_ms, expires_at_ms,
     email_preaccept_latest_occurred_ms, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_delivery')`)
    .bind(
      id,
      input.event.caller.businessPortfolioId,
      input.event.caller.businessScopedUserId,
      input.event.businessPhoneNumberId,
      input.event.messageEvidence.providerMessageId,
      input.digest,
      correlationToken,
      disclosureJson,
      input.receivedAtMs,
      input.receivedAtMs + dayMs,
      Option.isSome(Schema.decodeOption(EmailAddress)(input.event.content.text))
        ? DateTime.toEpochMillis(input.event.occurredAt)
        : null
    );

const admitExchange = (
  db: D1Database,
  exchange: NewExchange
): Effect.Effect<Response, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const { input, id, disclosure } = exchange;
    const disclosureJson = yield* Schema.encodeEffect(PendingDisclosureJson)(disclosure);
    const statement = exchangeStatement(db, exchange, disclosureJson);
    const portfolio = input.event.caller.businessPortfolioId;
    const bsuid = input.event.caller.businessScopedUserId;
    const caller = `${portfolio.length}:${portfolio}${bsuid.length}:${bsuid}`;
    const cryptoService = yield* Crypto.Crypto;
    const sourceHash = Hex.encode(
      yield* cryptoService.digest("SHA-256", new TextEncoder().encode(caller))
    );
    const claim = yield* Effect.result(
      admitResource(admission(db, input.receivedAtMs), {
        charges: consentCharges(sourceHash),
        grantId: ResourceAdmissionGrantId.make(id),
        statements: [
          db
            .prepare(`DELETE FROM pending_consent_exchanges
            WHERE portfolio_id = ? AND bsuid = ? AND expires_at_ms <= ?`)
            .bind(
              input.event.caller.businessPortfolioId,
              input.event.caller.businessScopedUserId,
              input.receivedAtMs
            ),
          db
            .prepare(`DELETE FROM pending_consent_exchanges WHERE id IN (
            SELECT id FROM pending_consent_exchanges WHERE expires_at_ms <= ?
            ORDER BY expires_at_ms LIMIT ?)`)
            .bind(input.receivedAtMs, expiredExchangeSweepLimit),
          statement,
        ],
      })
    );
    if (Result.isSuccess(claim)) return answer(HTTP_OK);
    return answer(
      claim.failure instanceof ResourceAdmissionRefused ? HTTP_CONFLICT : HTTP_UNAVAILABLE
    );
  }).pipe(Effect.catchCause(() => Effect.succeed(answer(HTTP_UNAVAILABLE))));

const DisclosureRecoveryRow = Schema.Struct({
  id: PendingConsentExchangeId,
  portfolio_id: WhatsAppBusinessPortfolioId,
  bsuid: WhatsAppBusinessScopedUserId,
  phone_number_id: WhatsAppBusinessPhoneNumberId,
  correlation_token: DisclosureDeliveryCorrelationToken,
  disclosure_json: Schema.String,
});

/** One durable claim fences either synchronous or scheduled execution before provider I/O. */
const runDisclosureAttempt = <R>({
  db,
  id,
  send,
}: Readonly<{
  db: D1Database;
  id: PendingConsentExchangeId;
  send: Effect.Effect<WhatsAppSentMessage, WhatsAppSendFailed, R>;
}>): Effect.Effect<boolean, void, R> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const claimed = yield* attempt(() =>
      db
        .prepare(`UPDATE pending_consent_exchanges
      SET state = 'outbound_started' WHERE id = ? AND state = 'awaiting_delivery'
        AND expires_at_ms > ?`)
        .bind(id, now)
        .run()
    );
    if (claimed.meta.changes !== 1) return false;
    const result = yield* Effect.exit(send).pipe(
      Effect.tap((exit) =>
        Effect.annotateCurrentSpan("outcome", Exit.isSuccess(exit) ? "succeeded" : "failed")
      ),
      Effect.withSpan("consent.disclosure.send")
    );
    if (Exit.isSuccess(result)) {
      yield* attempt(() =>
        db
          .prepare(`UPDATE pending_consent_exchanges
        SET disclosure_message_id = ? WHERE id = ? AND state = 'outbound_started'
          AND disclosure_message_id IS NULL`)
          .bind(result.value.messageEvidence.providerMessageId, id)
          .run()
      );
    }
    return true;
  });

const sendRecoveredDisclosure = (
  db: D1Database,
  candidate: typeof DisclosureRecoveryRow.Type,
  send: DisclosureSender
): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const disclosure = yield* Schema.decodeEffect(PendingDisclosureJson)(
      candidate.disclosure_json
    ).pipe(Effect.mapError(() => undefined));
    yield* runDisclosureAttempt({
      db,
      id: candidate.id,
      send: send({
        caller: {
          businessPortfolioId: candidate.portfolio_id,
          businessScopedUserId: candidate.bsuid,
          parentBusinessScopedUserId: Option.none(),
          username: Option.none(),
          phoneNumber: Option.none(),
        },
        phoneNumberId: candidate.phone_number_id,
        disclosure,
        correlationToken: candidate.correlation_token,
      }),
    });
    // Once claimed, a callback may reconcile the attempt; this loop never resends it.
  });

/** Resume only exchanges whose irreversible provider boundary was never claimed. */
export const recoverDisclosures = ({
  db,
  delivery,
}: Readonly<{
  db: D1Database;
  delivery: Option.Option<DisclosureSender>;
}>): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const raw = yield* attempt(() =>
      db
        .prepare(`SELECT id, portfolio_id, bsuid, phone_number_id, correlation_token, disclosure_json
          FROM pending_consent_exchanges WHERE state = 'awaiting_delivery' AND expires_at_ms > ?
          ORDER BY created_at_ms LIMIT 16`)
        .bind(now)
        .all()
    );
    const candidates = yield* Schema.decodeUnknownEffect(Schema.Array(DisclosureRecoveryRow))(
      raw.results
    ).pipe(Effect.mapError(() => undefined));
    if (candidates.length === 0) return;
    if (Option.isNone(delivery)) return yield* Effect.fail(undefined);
    for (const candidate of candidates) {
      yield* sendRecoveredDisclosure(db, candidate, delivery.value);
    }
  });

const sendExchange = (
  environment: Environment,
  { input, id, correlationToken, disclosure }: NewExchange
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (Option.isNone(environment.delivery)) return answer(HTTP_UNAVAILABLE);
    const claimed = yield* runDisclosureAttempt({
      db: environment.DB,
      id,
      send: environment.delivery.value.sendDisclosure({
        caller: input.event.caller,
        phoneNumberId: input.event.businessPhoneNumberId,
        correlationToken,
        disclosure,
      }),
    });
    if (!claimed) return answer(HTTP_UNAVAILABLE);
    // Synchronous send acceptance is never disclosure delivery. A lifecycle callback must prove it.
    return answer(HTTP_OK);
  }).pipe(Effect.catchCause(() => Effect.succeed(answer(HTTP_UNAVAILABLE))));

const priorExchangeResponse = (
  prior: Option.Option<StoredExchange>,
  input: Inbound
): Option.Option<Response> => {
  const verdict = classifyConsentIngressReplay({
    exchange: Option.map(prior, (stored) => stored.lifecycle),
    message: ingressMessage(input),
  });
  if (verdict === "new") return Option.none();
  // Outbound started is never retried: a lost provider response may have sent the disclosure.
  return Option.some(answer(verdict === "replay" ? HTTP_OK : HTTP_CONFLICT));
};

const recordUndeliveredMailbox = (
  db: D1Database,
  input: Inbound,
  pending: Option.Option<StoredExchange>
): Effect.Effect<Option.Option<Response>, void> =>
  Effect.gen(function* () {
    if (
      Option.isNone(pending) ||
      (pending.value.state !== "awaiting_delivery" && pending.value.state !== "outbound_started") ||
      Option.isNone(Schema.decodeOption(EmailAddress)(input.event.content.text))
    ) {
      return Option.none();
    }
    if (
      pending.value.phone_number_id !== input.event.businessPhoneNumberId ||
      input.receivedAtMs >= pending.value.expires_at_ms
    ) {
      return Option.some(answer(HTTP_CONFLICT));
    }
    return Option.some(yield* recordPrematureMailbox(db, input, pending.value.id));
  });

const startExchange = (
  environment: Environment,
  input: Inbound
): Effect.Effect<Response, void, Crypto.Crypto> =>
  Effect.gen(function* () {
    const pending = yield* findExchange(environment.DB, input.event);
    const premature = yield* recordUndeliveredMailbox(environment.DB, input, pending);
    if (Option.isSome(premature)) return premature.value;
    const prior = priorExchangeResponse(pending, input);
    if (Option.isSome(prior)) return prior.value;
    if (Option.isNone(environment.delivery)) {
      return answer(HTTP_UNAVAILABLE);
    }
    const disclosure = yield* Effect.exit(Effect.sync(() => currentDisclosureFor()));
    if (Exit.isFailure(disclosure)) return answer(HTTP_UNAVAILABLE);
    const cryptoService = yield* Crypto.Crypto;
    const id = PendingConsentExchangeId.make(yield* cryptoService.randomUUIDv4.pipe(Effect.orDie));
    const correlationToken = DisclosureDeliveryCorrelationToken.make(
      yield* cryptoService.randomUUIDv4.pipe(Effect.orDie)
    );
    const exchange = { input, id, correlationToken, disclosure: disclosure.value };
    const admitted = yield* admitExchange(environment.DB, exchange);
    if (admitted.status !== HTTP_OK) return admitted;
    return yield* sendExchange(environment, exchange);
  });

const requestsEmailStatus = (input: Inbound): boolean =>
  input.event.content.text.trim().toLocaleLowerCase("es-CO") === "estado";

const acceptedLive = (pending: Option.Option<StoredExchange>, receivedAtMs: number): boolean =>
  Option.isSome(pending) &&
  pending.value.state === "accepted" &&
  pending.value.expires_at_ms > receivedAtMs;

export const receiveConsentText = ({
  environment,
  input,
}: Readonly<{ environment: Environment; input: Inbound }>): Effect.Effect<
  Response,
  void,
  Crypto.Crypto
> =>
  Effect.gen(function* () {
    const pending = yield* findExchange(environment.DB, input.event);
    if (acceptedLive(pending, input.receivedAtMs)) {
      const choice = yield* decideConsentReply({ _tag: "Text", text: input.event.content.text });
      return choice._tag === "Clarify"
        ? answer(HTTP_OK)
        : yield* recordDecision(environment.DB, input);
    }
    if (
      Option.isSome(pending) &&
      pending.value.expires_at_ms > input.receivedAtMs &&
      isConsentIngressDecisionPhase(pending.value.lifecycle)
    ) {
      return yield* recordDecision(environment.DB, input);
    }
    if (requestsEmailStatus(input)) return answer(HTTP_CONFLICT);
    return yield* startExchange(environment, input);
  });

/** Expire pre-User evidence even when no new webhook arrives. */
export const sweepExpired = (db: D1Database) => (): Effect.Effect<void, void> =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    yield* attempt(() =>
      db
        .prepare(`DELETE FROM pending_consent_exchanges WHERE id IN (
        SELECT id FROM pending_consent_exchanges WHERE expires_at_ms <= ?
        ORDER BY expires_at_ms LIMIT ?
      )`)
        .bind(nowMs, scheduledExchangeSweepLimit)
        .run()
    );
    yield* expireVoiceRefusals({ db, now: nowMs });
    const expired = yield* attempt(() =>
      db
        .prepare(`SELECT g.id FROM resource_admission_grants AS g
        JOIN resource_admission_events AS e ON e.grant_id = g.id
        WHERE g.id IN (
          SELECT grant_id FROM resource_admission_events
          WHERE policy_key = 'consent.source.v1' AND expires_at_epoch_ms <= ?
        )
        GROUP BY g.id HAVING MAX(e.expires_at_epoch_ms) <= ?
        ORDER BY MAX(e.expires_at_epoch_ms) LIMIT ?`)
        .bind(nowMs, nowMs, scheduledExchangeSweepLimit)
        .all()
    );
    const grantIds = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ id: Schema.String }))
    )(expired.results).pipe(Effect.mapError(() => undefined));
    if (grantIds.length === 0) return;
    const placeholders = grantIds.map(() => "?").join(", ");
    const ids = grantIds.map(({ id }) => id);
    yield* attempt(() =>
      db.batch([
        db
          .prepare(`DELETE FROM resource_admission_events WHERE grant_id IN (${placeholders})`)
          .bind(...ids),
        db
          .prepare(`DELETE FROM resource_admission_grants WHERE id IN (${placeholders})`)
          .bind(...ids),
      ])
    );
  });
