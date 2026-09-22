import {
  ConsentIngressExchange,
  type ConsentIngressMessage,
  DisclosureDeliveryCorrelationToken,
  type KapsoSendFailed,
  type KapsoSentMessage,
  PendingConsentExchangeId,
  PendingDisclosureJson,
  Sha256Digest,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  type WhatsAppDeliveryKey,
  type WhatsAppInboundEvent,
  WhatsAppProviderMessageId,
  canRecordConsentIngressDecision,
  classifyConsentIngressReplay,
  currentDisclosureFor,
  decideConsentReply,
  decodeKapsoDisclosureLifecycleWebhook,
  decodeKapsoWebhook,
  isConsentIngressDecisionPhase,
  makeDisclosureSender,
  maxKapsoFutureTimestampMinutes,
  maxKapsoWebhookBytes,
} from "@fidy/server/consent-ingress";
import {
  Context,
  Crypto,
  DateTime,
  Duration,
  Effect,
  Encoding,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  ResourceAdmissionAuthority,
  type ResourceAdmissionAuthorityService,
  ResourceAdmissionCharges,
  type ResourceAdmissionCharges as ResourceAdmissionChargesType,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "./resource-admission";

const dayMs = 86_400_000;
// Initiation must become ineligible before its receipt-based exchange expires, even
// when Kapso's signed event clock leads our receipt clock by its full tolerance.
const maxKapsoFutureSkewMs = Duration.toMillis(Duration.minutes(maxKapsoFutureTimestampMinutes));
const maxInitiatingEventAgeMs = dayMs - maxKapsoFutureSkewMs;
const hourMs = 3_600_000;
const maximumHourlyDisclosures = 500;
const expiredExchangeSweepLimit = 32;
const scheduledExchangeSweepLimit = 128;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE = 422;
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
const admission = (db: D1Database, now: number): ResourceAdmissionAuthorityService =>
  ResourceAdmissionAuthority.make({
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

type Environment = Readonly<{
  readonly DB: D1Database;
  readonly KAPSO_API_KEY: string;
  readonly KAPSO_WEBHOOK_SECRET: string;
  readonly WHATSAPP_BUSINESS_PORTFOLIO_ID: string;
}>;
type Inbound = Readonly<{
  readonly event: WhatsAppInboundEvent;
  readonly deliveryKey: WhatsAppDeliveryKey;
  readonly digest: Sha256Digest;
  readonly receivedAtMs: number;
}>;

const answer = (status: number): Response =>
  new Response(null, { status, headers: { "cache-control": "no-store" } });

/** Keep foreign I/O failures distinct from an absent result; the ingress maps them to 503. */
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

/** Bound the actual streamed raw bytes, not the untrusted Content-Length claim. */
const boundedBody = (request: Request): Effect.Effect<Option.Option<Uint8Array>, void> => {
  const stream = request.body;
  if (stream === null) return Effect.succeedSome(new Uint8Array());
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Array<Uint8Array> = [];
        let length = 0;
        while (true) {
          const part = yield* attempt(() => reader.read());
          if (part.done) break;
          length += part.value.byteLength;
          if (length > maxKapsoWebhookBytes) return Option.none();
          chunks.push(part.value);
        }
        const body = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return Option.some(body);
      }),
    (reader) =>
      Effect.exit(attempt(() => reader.cancel())).pipe(
        Effect.andThen(Effect.sync(() => reader.releaseLock()))
      )
  );
};

type StoredExchange = typeof PendingExchangeRow.Type & {
  readonly lifecycle: ConsentIngressExchange;
};

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
    initiating_message_id, initiating_body_sha256 FROM pending_consent_exchanges
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
      admission(db, input.receivedAtMs).releaseOutstandingWork({
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

const recordDecision = (db: D1Database, input: Inbound): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const replay = yield* findRecordedDecision(db, input);
    if (Option.isSome(replay)) return replay.value;
    const choice = yield* decideConsentReply({ _tag: "Text", text: input.event.content.text });
    if (choice._tag === "Clarify") return answer(HTTP_OK);
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
    return yield* persistDecision({ db, input, pending: pending.value, decision });
  });

const sameDelivery = (
  row: typeof DeliveryRow.Type,
  input: Pick<DeliveryInput, "messageId" | "phoneNumberId" | "occurredAtMs">
): boolean =>
  row.message_id === input.messageId &&
  row.phone_number_id === input.phoneNumberId &&
  row.occurred_at_ms === input.occurredAtMs;

type DeliveryInput = Readonly<{
  correlationToken: DisclosureDeliveryCorrelationToken;
  phoneNumberId: WhatsAppBusinessPhoneNumberId;
  messageId: WhatsAppProviderMessageId;
  occurredAtMs: number;
  receivedAtMs: number;
}>;

const findDelivery = (
  db: D1Database,
  token: DisclosureDeliveryCorrelationToken
): Effect.Effect<Option.Option<typeof DeliveryRow.Type>, void> =>
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

const recordDelivery = (db: D1Database, input: DeliveryInput): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const existing = yield* findDelivery(db, input.correlationToken);
    if (Option.isSome(existing)) {
      return answer(sameDelivery(existing.value, input) ? HTTP_OK : HTTP_CONFLICT);
    }
    const inserted = yield* Effect.exit(
      attempt(() =>
        db
          .prepare(`INSERT INTO pending_consent_delivery
      (correlation_token, phone_number_id, message_id, occurred_at_ms, received_at_ms, decision_not_before_ms)
      VALUES (?, ?, ?, ?, ?, ?)`)
          .bind(
            input.correlationToken,
            input.phoneNumberId,
            input.messageId,
            input.occurredAtMs,
            input.receivedAtMs,
            input.receivedAtMs + maxKapsoFutureSkewMs
          )
          .run()
      )
    );
    if (Exit.isSuccess(inserted)) return answer(HTTP_OK);
    const retry = yield* findDelivery(db, input.correlationToken);
    return answer(
      Option.isSome(retry) && sameDelivery(retry.value, input) ? HTTP_OK : HTTP_CONFLICT
    );
  });

const deliveryEffect = (
  environment: Environment,
  input: Readonly<{
    readonly event: WhatsAppInboundEvent;
    readonly correlationToken: DisclosureDeliveryCorrelationToken;
    readonly disclosure: ReturnType<typeof currentDisclosureFor>;
  }>
): Effect.Effect<KapsoSentMessage, KapsoSendFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* makeDisclosureSender({
      apiKey: Redacted.make(environment.KAPSO_API_KEY),
      httpClient,
    })({
      caller: input.event.caller,
      phoneNumberId: input.event.businessPhoneNumberId,
      disclosure: input.disclosure,
      correlationToken: input.correlationToken,
    });
  });

type NewExchange = Readonly<{
  input: Inbound;
  id: PendingConsentExchangeId;
  correlationToken: DisclosureDeliveryCorrelationToken;
  disclosure: ReturnType<typeof currentDisclosureFor>;
}>;

const admitExchange = (
  db: D1Database,
  { input, id, correlationToken, disclosure }: NewExchange
): Effect.Effect<Response, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const disclosureJson = yield* Schema.encodeEffect(PendingDisclosureJson)(disclosure);
    const statement = db
      .prepare(`INSERT INTO pending_consent_exchanges
      (id, portfolio_id, bsuid, phone_number_id, initiating_message_id, initiating_body_sha256,
       correlation_token, disclosure_json, created_at_ms, expires_at_ms, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_delivery')`)
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
        input.receivedAtMs + dayMs
      );
    const portfolio = input.event.caller.businessPortfolioId;
    const bsuid = input.event.caller.businessScopedUserId;
    const caller = `${portfolio.length}:${portfolio}${bsuid.length}:${bsuid}`;
    const cryptoService = yield* Crypto.Crypto;
    const sourceHash = Encoding.encodeHex(
      yield* cryptoService.digest("SHA-256", new TextEncoder().encode(caller))
    );
    const claim = yield* Effect.exit(
      admission(db, input.receivedAtMs).admit({
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
    return answer(Exit.isFailure(claim) ? HTTP_CONFLICT : HTTP_OK);
  }).pipe(Effect.catchCause(() => Effect.succeed(answer(HTTP_UNAVAILABLE))));

const sendExchange = (
  environment: Environment,
  { input, id, correlationToken, disclosure }: NewExchange
): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    // Persist the irreversible provider boundary before the call; a crash must not resend it.
    const claim = yield* attempt(() =>
      environment.DB.prepare(
        `UPDATE pending_consent_exchanges SET state = 'outbound_started'
      WHERE id = ? AND state = 'awaiting_delivery'`
      )
        .bind(id)
        .run()
    );
    if (claim.meta.changes !== 1) return answer(HTTP_UNAVAILABLE);
    const result = yield* Effect.exit(
      deliveryEffect(environment, { event: input.event, correlationToken, disclosure })
    ).pipe(
      Effect.tap((exit) =>
        Effect.annotateCurrentSpan("outcome", Exit.isSuccess(exit) ? "succeeded" : "failed")
      ),
      Effect.withSpan("consent.disclosure.send")
    );
    if (Exit.isSuccess(result)) {
      yield* attempt(() =>
        environment.DB.prepare(
          `UPDATE pending_consent_exchanges SET disclosure_message_id = ?
        WHERE id = ? AND state = 'outbound_started' AND disclosure_message_id IS NULL`
        )
          .bind(result.value.messageEvidence.providerMessageId, id)
          .run()
      );
    }
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

const startExchange = (
  environment: Environment,
  input: Inbound
): Effect.Effect<Response, void, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const prior = priorExchangeResponse(yield* findExchange(environment.DB, input.event), input);
    if (Option.isSome(prior)) return prior.value;
    if (environment.KAPSO_API_KEY.length === 0) {
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

type WebhookBase = Readonly<{
  rawBody: Uint8Array;
  secret: Redacted.Redacted<string>;
  signature: string;
  receivedAt: DateTime.Utc;
}>;

const handleDelivery = (base: WebhookBase, db: D1Database): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeKapsoDisclosureLifecycleWebhook({ ...base, eventName: "whatsapp.message.delivered" })
    );
    if (Exit.isFailure(result)) return answer(HTTP_UNAUTHORIZED);
    return yield* recordDelivery(db, {
      correlationToken: result.value.correlationToken,
      phoneNumberId: result.value.businessPhoneNumberId,
      messageId: result.value.messageEvidence.providerMessageId,
      occurredAtMs: DateTime.toEpochMillis(result.value.occurredAt),
      receivedAtMs: DateTime.toEpochMillis(base.receivedAt),
    });
  });

const handleInbound = (
  base: WebhookBase,
  request: Request,
  environment: Environment
): Effect.Effect<Response, void, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const decoded = yield* Effect.exit(
      decodeKapsoWebhook({
        ...base,
        deliveryKey: request.headers.get("x-idempotency-key") ?? "",
        businessPortfolioId: environment.WHATSAPP_BUSINESS_PORTFOLIO_ID,
      })
    );
    if (Exit.isFailure(decoded)) return answer(HTTP_UNAUTHORIZED);
    // Never partially settle a buffered retry delivery or re-admit stale signed events.
    if (decoded.value.events.length !== 1) return answer(HTTP_UNPROCESSABLE);
    if (
      DateTime.toEpochMillis(decoded.value.events[0].occurredAt) + maxInitiatingEventAgeMs <=
      DateTime.toEpochMillis(base.receivedAt)
    ) {
      return answer(HTTP_CONFLICT);
    }
    const cryptoService = yield* Crypto.Crypto;
    const digest = Sha256Digest.make(
      Encoding.encodeHex(yield* cryptoService.digest("SHA-256", base.rawBody).pipe(Effect.orDie))
    );
    const input = {
      event: decoded.value.events[0],
      deliveryKey: decoded.value.deliveryKey,
      digest,
      receivedAtMs: DateTime.toEpochMillis(base.receivedAt),
    };
    const pending = yield* findExchange(environment.DB, input.event);
    if (
      Option.isSome(pending) &&
      pending.value.expires_at_ms > input.receivedAtMs &&
      isConsentIngressDecisionPhase(pending.value.lifecycle)
    ) {
      return yield* recordDecision(environment.DB, input);
    }
    return yield* startExchange(environment, input);
  });

const handleWebhook = (
  request: Request,
  environment: Environment
): Effect.Effect<Response, void, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (
      request.headers.get("content-length") !== null &&
      Number(request.headers.get("content-length")) > maxKapsoWebhookBytes
    ) {
      return answer(HTTP_PAYLOAD_TOO_LARGE);
    }
    const rawBody = yield* boundedBody(request);
    if (Option.isNone(rawBody)) return answer(HTTP_PAYLOAD_TOO_LARGE);
    const receivedAt = yield* DateTime.now;
    const base = {
      rawBody: rawBody.value,
      secret: Redacted.make(environment.KAPSO_WEBHOOK_SECRET),
      signature: request.headers.get("x-webhook-signature") ?? "",
      receivedAt,
    };
    const eventName = request.headers.get("x-webhook-event");
    if (eventName === "whatsapp.message.delivered") {
      return yield* handleDelivery(base, environment.DB);
    }
    if (eventName !== "whatsapp.message.received") return answer(HTTP_UNPROCESSABLE);
    return yield* handleInbound(base, request, environment);
  });

const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    attempt(() =>
      crypto.subtle.digest(algorithm, new Uint8Array(data)).then((buffer) => new Uint8Array(buffer))
    ).pipe(Effect.orDie),
});

/** Expire pre-User evidence even when no new webhook arrives. */
export const sweepExpiredConsent = (db: D1Database) => (): Effect.Effect<void, void> =>
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

/** One authenticated, bounded provider ingress. No decision can bypass provider delivery proof. */
export const receiveConsentWebhook =
  (environment: Environment): ((request: Request) => Effect.Effect<Response>) =>
  (request) =>
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(FetchHttpClient.layer);
        return yield* handleWebhook(request, environment).pipe(
          Effect.provideService(HttpClient.HttpClient, Context.get(clients, HttpClient.HttpClient)),
          Effect.provideService(Crypto.Crypto, workerCrypto)
        );
      })
    ).pipe(
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      Effect.catchCause(() => Effect.succeed(answer(HTTP_UNAVAILABLE)))
    );
