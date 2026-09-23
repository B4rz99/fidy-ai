import {
  BillingAttempt,
  BillingAttemptId,
  BillingEmail,
  CardEnrollment,
  CardEnrollmentId,
  CardPaymentSourceId,
  CardPaymentSubmission,
  PrepareCardEnrollmentPayload,
  Price,
  RecurringDisclosure,
  SubmitCardEnrollmentPayload,
  WompiContractEvidenceSet,
  type WompiEnrollmentClientService,
  WompiSourceId,
  cardEnrollmentInvalidBody,
  cardEnrollmentUnavailableBody,
  makeWompiEnrollmentClient,
  makeWompiOutboundHttp,
} from "@fidy/server/subscription-runtime";
import { Context, Crypto, DateTime, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { UserId } from "@fidy/server/identity-runtime";
import { claimPreparedCardEnrollment } from "./card-enrollment-claim";
import { RequestBodyPolicy, readBoundedRequestBody } from "./request-body";
import { browserOrigins } from "./topology";

const Origin = Schema.Literals([browserOrigins.production, browserOrigins.local]);
const WompiConfiguration = Schema.Struct({
  BROWSER_ORIGIN: Origin,
  WOMPI_ENVIRONMENT: Schema.Literals(["sandbox", "production"]),
  WOMPI_PUBLIC_KEY: Schema.String.check(Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)),
  WOMPI_PRIVATE_KEY: Schema.String.check(
    Schema.isPattern(/^prv_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)
  ),
  WOMPI_INTEGRITY_SECRET: Schema.String.check(
    Schema.isPattern(/^(?:test|prod)_integrity_[A-Za-z0-9_-]{8,}$/u)
  ),
});
const Session = Schema.Struct({
  user_id: Schema.String.check(Schema.isUUID()),
  time_zone: Schema.String.check(Schema.isNonEmpty()),
  email_address: BillingEmail,
});
const PriceRow = Schema.Struct({
  id: Price.fields.id,
  amount: Schema.String,
  currency: Schema.String,
  billing_period: Schema.String,
  service_market: Schema.String,
  tax_treatment: Schema.String,
  terms_json: Schema.String,
});
const Terms = Schema.Struct({
  ...Price.fields.renewalTerms.fields,
  paymentMethods: Price.fields.paymentMethods,
});
const EnrollmentRow = Schema.Struct({
  id: CardEnrollmentId,
  user_id: Schema.String.check(Schema.isUUID()),
  price_id: Price.fields.id,
  billing_email: BillingEmail,
  payment_source_mode: Schema.Literals(["create", "reuse"]),
  status: Schema.Literals([
    "preparing",
    "prepared",
    "creating",
    "available",
    "refused",
    "expired",
    "verifying",
  ]),
  contracts_json: Schema.String,
  disclosure_json: Schema.String,
  expires_at_ms: Schema.Finite,
  payment_request_id: Schema.NullOr(Schema.String),
  wompi_candidate_source_id: Schema.NullOr(Schema.Finite),
  refusal_reason: Schema.NullOr(
    Schema.Literals(["provider-declined", "provider-error", "terms-changed"])
  ),
});
const AttemptRow = Schema.Struct({
  id: BillingAttemptId,
  price_id: Price.fields.id,
  amount: Schema.String,
  currency: Schema.String,
  billing_period: Schema.String,
  service_market: Schema.String,
  tax_treatment: Schema.String,
  time_zone: Schema.String,
  created_at_ms: Schema.Finite,
  status: Schema.Literals(["pending", "succeeded", "failed"]),
  finalized_at_ms: Schema.NullOr(Schema.Finite),
});
const preparationWindowMs = 3_600_000;
const verificationCooldownMs = 3_000;
const maximumVerificationAttempts = 8;
const maximumPreparationsPerHour = 12;
const enrollmentLifetimeMs = 900_000;
const hexBase = 16;
const forbiddenStatus = 403;
const unauthorizedStatus = 401;
const uuidPath = /^\/web\/subscription\/(?:card-enrollments|billing-attempts)\/([0-9a-f-]{36})$/u;
const jsonPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 6144,
  deadlineMilliseconds: 2000,
});
const noStore = { "cache-control": "no-store" };
const invalid = (status = 400): Response =>
  Response.json(cardEnrollmentInvalidBody, { status, headers: noStore });
const unavailable = (): Response =>
  Response.json(cardEnrollmentUnavailableBody, { status: 503, headers: noStore });
const json = (body: unknown): Response => Response.json(body, { headers: noStore });
const instant = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
// @effect-diagnostics-next-line cryptoRandomUUID:off
const id = (): string => crypto.randomUUID();
// @effect-diagnostics-next-line asyncFunction:off
const digest = async (text: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
const decodeJson = (text: string): unknown => JSON.parse(text);
const parse = <A, E>(schema: Schema.Codec<A, E>, text: string): Option.Option<A> =>
  Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(decodeJson(text));
const decodeRow = <A, E>(schema: Schema.Codec<A, E>, row: unknown): Option.Option<A> =>
  Schema.decodeUnknownOption(schema)(row);

const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, bytes) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, new Uint8Array(bytes))
          .then((value) => new Uint8Array(value)),
      catch: () => undefined,
    }).pipe(Effect.orDie),
});

type EnrollmentEnvironment = { readonly DB: D1Database } & Partial<{
  readonly BROWSER_ORIGIN: string;
  readonly WOMPI_ENVIRONMENT: string;
  readonly WOMPI_PUBLIC_KEY: string;
  readonly WOMPI_PRIVATE_KEY: string;
  readonly WOMPI_INTEGRITY_SECRET: string;
}>;
type ConfiguredEnrollmentEnvironment = typeof WompiConfiguration.Type & { readonly DB: D1Database };

// @effect-diagnostics-next-line asyncFunction:off
const makeWompi = async (
  environment: ConfiguredEnrollmentEnvironment
): Promise<WompiEnrollmentClientService> => {
  const clients = await Effect.runPromise(
    Effect.scoped(
      Layer.build(FetchHttpClient.layer).pipe(
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch)
      )
    )
  );
  const outboundHttp = makeWompiOutboundHttp({
    environment: environment.WOMPI_ENVIRONMENT,
    publicKey: environment.WOMPI_PUBLIC_KEY,
    privateKey: Redacted.make(environment.WOMPI_PRIVATE_KEY),
    integritySecret: Redacted.make(environment.WOMPI_INTEGRITY_SECRET),
    httpClient: Context.get(clients, HttpClient.HttpClient),
    crypto: workerCrypto,
  });
  return makeWompiEnrollmentClient({
    outboundHttp,
    crypto: workerCrypto,
    publicKey: environment.WOMPI_PUBLIC_KEY,
  });
};

// @effect-diagnostics-next-line asyncFunction:off
const authority = async (
  request: Request,
  db: D1Database,
  at: number
): Promise<Option.Option<typeof Session.Type>> => {
  const cookies =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim()) ?? [];
  const matches = cookies.filter((part) => part.startsWith("__Host-fidy_session="));
  if (matches.length !== 1) return Option.none();
  const token = matches[0]?.slice("__Host-fidy_session=".length) ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return Option.none();
  const row = await db
    .prepare(`SELECT s.user_id, u.time_zone, v.email_address FROM web_sessions AS s
    JOIN users AS u ON u.id = s.user_id
    JOIN verified_email_credentials AS v ON v.user_id = s.user_id
    JOIN onboarding_consent_records AS c ON c.user_id = s.user_id
    WHERE s.token_digest = ? AND s.revoked_at_ms IS NULL AND s.fresh_until_ms > ?
      AND s.idle_expires_at_ms > ? AND s.hard_expires_at_ms > ?`)
    .bind(await digest(token), at, at, at)
    .first();
  return decodeRow(Session, row);
};

// @effect-diagnostics-next-line asyncFunction:off
const price = async (db: D1Database, priceId: string): Promise<Option.Option<Price>> => {
  const row = decodeRow(
    PriceRow,
    await db
      .prepare(`SELECT id, amount, currency, billing_period,
    service_market, tax_treatment, terms_json FROM subscription_prices WHERE id = ?`)
      .bind(priceId)
      .first()
  );
  if (Option.isNone(row)) return Option.none();
  const terms = parse(Terms, row.value.terms_json);
  if (Option.isNone(terms)) return Option.none();
  return decodeRow(Price, {
    id: row.value.id,
    money: { amount: row.value.amount, currency: row.value.currency },
    billingPeriod: row.value.billing_period,
    serviceMarket: row.value.service_market,
    taxTreatment: row.value.tax_treatment,
    renewalTerms: terms.value,
    paymentMethods: terms.value.paymentMethods,
  });
};

// @effect-diagnostics-next-line asyncFunction:off
const enrollment = async (
  db: D1Database,
  userId: string,
  enrollmentId: string
): Promise<Option.Option<typeof EnrollmentRow.Type>> =>
  decodeRow(
    EnrollmentRow,
    await db
      .prepare("SELECT * FROM card_enrollments WHERE id = ? AND user_id = ?")
      .bind(enrollmentId, userId)
      .first()
  );

const project = (
  row: typeof EnrollmentRow.Type,
  selectedPrice: Price,
  publicKey: string
): CardEnrollment => {
  switch (row.status) {
    case "prepared": {
      const contracts = parse(Schema.toCodecJson(WompiContractEvidenceSet), row.contracts_json);
      const disclosure = parse(Schema.toCodecJson(RecurringDisclosure), row.disclosure_json);
      if (Option.isNone(contracts) || Option.isNone(disclosure)) {
        throw new Error("invalid enrollment evidence");
      }
      return {
        status: "prepared",
        enrollmentId: row.id,
        price: selectedPrice,
        billingEmail: row.billing_email,
        contracts: contracts.value,
        recurringDisclosure: disclosure.value,
        wompiPublicKey: publicKey,
        paymentSourceMode: row.payment_source_mode,
        expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
      };
    }
    case "preparing":
      throw new Error("preparation is not ready");
    case "refused":
      return {
        status: "refused",
        enrollmentId: row.id,
        priceId: row.price_id,
        reason: row.refusal_reason ?? "provider-error",
      };
    case "creating":
    case "available":
    case "expired":
    case "verifying":
      return { status: row.status, enrollmentId: row.id, priceId: row.price_id };
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const readBody = async <A, E>(
  request: Request,
  schema: Schema.Codec<A, E>
): Promise<Option.Option<A>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Option.none();
  }
  const result = await Effect.runPromiseExit(readBoundedRequestBody(request, jsonPolicy));
  if (Exit.isFailure(result)) return Option.none();
  try {
    return parse(schema, new TextDecoder("utf-8", { fatal: true }).decode(result.value));
  } catch {
    return Option.none();
  }
};

// @effect-diagnostics-next-line asyncFunction:off
const prepare = async (
  request: Request,
  session: typeof Session.Type,
  environment: ConfiguredEnrollmentEnvironment,
  now: number
): Promise<Response> => {
  const body = await readBody(request, PrepareCardEnrollmentPayload);
  if (Option.isNone(body)) return invalid();
  const selected = await price(environment.DB, body.value.priceId);
  if (Option.isNone(selected)) return invalid();
  const active = await environment.DB.prepare(`SELECT id FROM card_enrollments WHERE user_id = ?
    AND status IN ('preparing', 'prepared', 'creating', 'verifying') ORDER BY prepared_at_ms DESC LIMIT 1`)
    .bind(session.user_id)
    .first();
  const activeId = decodeRow(Schema.Struct({ id: CardEnrollmentId }), active);
  if (Option.isSome(activeId)) {
    const existing = await enrollment(environment.DB, session.user_id, activeId.value.id);
    if (
      Option.isSome(existing) &&
      existing.value.price_id === selected.value.id &&
      existing.value.status === "prepared" &&
      existing.value.expires_at_ms > now
    ) {
      return json(
        Schema.encodeSync(Schema.toCodecJson(CardEnrollment))(
          project(existing.value, selected.value, environment.WOMPI_PUBLIC_KEY)
        )
      );
    }
    if (
      Option.isSome(existing) &&
      existing.value.status === "preparing" &&
      existing.value.expires_at_ms > now
    ) {
      return unavailable();
    }
    if (
      Option.isSome(existing) &&
      existing.value.status !== "prepared" &&
      existing.value.status !== "preparing"
    ) {
      const activePrice = await price(environment.DB, existing.value.price_id);
      return Option.isSome(activePrice)
        ? json(
            Schema.encodeSync(Schema.toCodecJson(CardEnrollment))(
              project(existing.value, activePrice.value, environment.WOMPI_PUBLIC_KEY)
            )
          )
        : unavailable();
    }
    await environment.DB.prepare(
      "UPDATE card_enrollments SET status = 'expired' WHERE id = ? AND user_id = ? AND status IN ('prepared', 'preparing')"
    )
      .bind(activeId.value.id, session.user_id)
      .run();
  }
  const capacity = await environment.DB.prepare(
    "SELECT count(*) AS count FROM card_enrollments WHERE user_id = ? AND prepared_at_ms > ?"
  )
    .bind(session.user_id, now - preparationWindowMs)
    .first();
  if (
    !Schema.is(Schema.Struct({ count: Schema.Finite }))(capacity) ||
    capacity.count >= maximumPreparationsPerHour
  ) {
    return unavailable();
  }
  const enrollmentId = CardEnrollmentId.make(id());
  const reserved = await environment.DB.prepare(`INSERT OR IGNORE INTO card_enrollments
    (id, user_id, price_id, billing_email, status, payment_source_mode, contracts_json,
    disclosure_json, prepared_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, 'preparing', 'create', '{}', '{}', ?, ?)`)
    .bind(
      enrollmentId,
      session.user_id,
      selected.value.id,
      session.email_address,
      now,
      now + enrollmentLifetimeMs
    )
    .run();
  if (reserved.meta.changes !== 1) return unavailable();
  const wompi = await makeWompi(environment);
  const contracts = await Effect.runPromiseExit(wompi.contracts(DateTime.makeUnsafe(now)));
  if (Exit.isFailure(contracts)) {
    await environment.DB.prepare(
      "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-error' WHERE id = ? AND status = 'preparing'"
    )
      .bind(enrollmentId)
      .run();
    return unavailable();
  }
  const statement = "Autorizo los cobros recurrentes de mi suscripción.";
  const disclosure = RecurringDisclosure.make({
    revision: "wompi-card-enrollment-v1",
    displayedText: statement,
    contentSha256: Array.from(await digest(statement), (byte) =>
      byte.toString(hexBase).padStart(2, "0")
    ).join(""),
  });
  const source = await environment.DB.prepare(
    "SELECT id FROM card_payment_sources WHERE user_id = ?"
  )
    .bind(session.user_id)
    .first();
  const inserted = await environment.DB.prepare(`UPDATE card_enrollments
    SET status = 'prepared', payment_source_mode = ?, contracts_json = ?, disclosure_json = ?
    WHERE id = ? AND user_id = ? AND status = 'preparing'`)
    .bind(
      source === null ? "create" : "reuse",
      JSON.stringify(
        Schema.encodeSync(Schema.toCodecJson(WompiContractEvidenceSet))(contracts.value.evidence)
      ),
      JSON.stringify(Schema.encodeSync(Schema.toCodecJson(RecurringDisclosure))(disclosure)),
      enrollmentId,
      session.user_id
    )
    .run();
  if (inserted.meta.changes !== 1) return unavailable();
  const retained = await enrollment(environment.DB, session.user_id, enrollmentId);
  return Option.isSome(retained)
    ? json(
        Schema.encodeSync(Schema.toCodecJson(CardEnrollment))(
          project(retained.value, selected.value, environment.WOMPI_PUBLIC_KEY)
        )
      )
    : unavailable();
};

// @effect-diagnostics-next-line asyncFunction:off
const attemptFor = async (
  db: D1Database,
  userId: string,
  attemptId: string
): Promise<Option.Option<BillingAttempt>> => {
  const row = decodeRow(
    AttemptRow,
    await db
      .prepare("SELECT * FROM billing_attempts WHERE id = ? AND user_id = ?")
      .bind(attemptId, userId)
      .first()
  );
  if (Option.isNone(row) || row.value.status !== "pending") return Option.none();
  return decodeRow(Schema.toCodecJson(BillingAttempt), {
    status: "pending",
    id: row.value.id,
    priceId: row.value.price_id,
    money: { amount: row.value.amount, currency: row.value.currency },
    billingPeriod: row.value.billing_period,
    serviceMarket: row.value.service_market,
    taxTreatment: row.value.tax_treatment,
    timeZone: row.value.time_zone,
    createdAt: instant(row.value.created_at_ms),
  });
};

// @effect-diagnostics-next-line asyncFunction:off
const finish = async (
  environment: ConfiguredEnrollmentEnvironment,
  userId: string,
  row: typeof EnrollmentRow.Type,
  requestId: string,
  session: typeof Session.Type,
  sourceId: string,
  now: number,
  wompiSourceId?: number
): Promise<Response> => {
  const selected = await price(environment.DB, row.price_id);
  if (Option.isNone(selected)) return unavailable();
  const attemptId = BillingAttemptId.make(id());
  const reference = `fidy-${attemptId}`;
  const statements = [
    ...(wompiSourceId === undefined
      ? []
      : [
          environment.DB.prepare(`INSERT INTO card_payment_sources
      (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(
            sourceId,
            userId,
            row.id,
            wompiSourceId,
            row.billing_email,
            now
          ),
        ]),
    environment.DB.prepare(
      "UPDATE card_enrollments SET status = 'available' WHERE id = ? AND user_id = ? AND status IN ('creating', 'verifying') AND payment_request_id = ?"
    ).bind(row.id, userId, requestId),
    environment.DB.prepare(`INSERT INTO billing_attempts (id, user_id, enrollment_id,
      payment_request_id, payment_source_id, price_id, amount, currency, billing_period,
      service_market, tax_treatment, time_zone, wompi_environment, wompi_reference, created_at_ms)
      SELECT ?, ?, ?, ?, ?, p.id, p.amount, p.currency, p.billing_period, p.service_market,
      p.tax_treatment, ?, ?, ?, ? FROM subscription_prices AS p JOIN card_enrollments AS e ON e.price_id = p.id
      WHERE e.id = ? AND e.user_id = ? AND e.status = 'available' AND e.payment_request_id = ?`).bind(
      attemptId,
      userId,
      row.id,
      requestId,
      sourceId,
      session.time_zone,
      environment.WOMPI_ENVIRONMENT,
      reference,
      now,
      row.id,
      userId,
      requestId
    ),
  ];
  const committed = await environment.DB.batch(statements);
  if (committed.at(-1)?.meta.changes !== 1) return unavailable();
  const attempt = await attemptFor(environment.DB, userId, attemptId);
  return Option.isSome(attempt)
    ? json(
        Schema.encodeSync(Schema.toCodecJson(CardPaymentSubmission))({
          status: "payment-pending",
          enrollmentId: row.id,
          billingAttempt: attempt.value,
        })
      )
    : unavailable();
};

// @effect-diagnostics-next-line asyncFunction:off
const resolveCandidate = async (
  environment: ConfiguredEnrollmentEnvironment,
  session: typeof Session.Type,
  row: typeof EnrollmentRow.Type,
  now: number
): Promise<Response> => {
  const candidate = row.wompi_candidate_source_id;
  if (candidate === null || row.payment_request_id === null) {
    return json({ status: "source-verifying", enrollmentId: row.id });
  }
  const claimedLookup = await environment.DB.prepare(`UPDATE card_enrollments
    SET verification_attempts = verification_attempts + 1, last_verification_at_ms = ?
    WHERE id = ? AND user_id = ? AND status = 'verifying' AND payment_request_id = ?
      AND wompi_candidate_source_id = ? AND verification_attempts < ?
      AND (last_verification_at_ms IS NULL OR last_verification_at_ms <= ?)`)
    .bind(
      now,
      row.id,
      session.user_id,
      row.payment_request_id,
      candidate,
      maximumVerificationAttempts,
      now - verificationCooldownMs
    )
    .run();
  if (claimedLookup.meta.changes !== 1) {
    return json({ status: "source-verifying", enrollmentId: row.id });
  }
  const wompi = await makeWompi(environment);
  const verified = await Effect.runPromiseExit(
    wompi.verifyPaymentSource(WompiSourceId.make(candidate))
  );
  if (Exit.isFailure(verified) || verified.value.sourceId !== candidate) {
    return json({ status: "source-verifying", enrollmentId: row.id });
  }
  if (verified.value.billingEmail !== row.billing_email) {
    await environment.DB.prepare(
      "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-error' WHERE id = ? AND user_id = ? AND status = 'verifying'"
    )
      .bind(row.id, session.user_id)
      .run();
    return json({ status: "refused", enrollmentId: row.id, reason: "provider-error" });
  }
  return finish(
    environment,
    session.user_id,
    row,
    row.payment_request_id,
    session,
    CardPaymentSourceId.make(id()),
    now,
    candidate
  );
};

// @effect-diagnostics-next-line asyncFunction:off
const submit = async (
  request: Request,
  session: typeof Session.Type,
  environment: ConfiguredEnrollmentEnvironment,
  now: number
): Promise<Response> => {
  const body = await readBody(request, SubmitCardEnrollmentPayload);
  if (Option.isNone(body)) return invalid();
  const input = body.value;
  let row = await enrollment(environment.DB, session.user_id, input.enrollmentId);
  if (Option.isNone(row)) return invalid();
  if (
    row.value.payment_request_id !== null &&
    row.value.payment_request_id !== input.paymentRequestId
  ) {
    return invalid();
  }
  const existing = await environment.DB.prepare(
    "SELECT id, enrollment_id FROM billing_attempts WHERE user_id = ? AND payment_request_id = ?"
  )
    .bind(session.user_id, input.paymentRequestId)
    .first();
  const existingId = decodeRow(
    Schema.Struct({ id: BillingAttemptId, enrollment_id: CardEnrollmentId }),
    existing
  );
  if (Option.isSome(existingId)) {
    if (existingId.value.enrollment_id !== row.value.id) return invalid();
    const attempt = await attemptFor(environment.DB, session.user_id, existingId.value.id);
    return Option.isSome(attempt)
      ? json(
          Schema.encodeSync(Schema.toCodecJson(CardPaymentSubmission))({
            status: "payment-pending",
            enrollmentId: row.value.id,
            billingAttempt: attempt.value,
          })
        )
      : invalid();
  }
  if (row.value.status === "creating") {
    return json({ status: "source-verifying", enrollmentId: row.value.id });
  }
  if (row.value.status === "verifying") {
    return resolveCandidate(environment, session, row.value, now);
  }
  if (row.value.status === "expired" || row.value.expires_at_ms <= now) {
    return json({ status: "refused", enrollmentId: row.value.id, reason: "expired" });
  }
  if (row.value.status === "refused") {
    return json({
      status: "refused",
      enrollmentId: row.value.id,
      reason: row.value.refusal_reason ?? "provider-error",
    });
  }
  if (
    row.value.status !== "prepared" ||
    row.value.payment_source_mode !== input.paymentSourceMode ||
    row.value.billing_email !== input.billingEmail
  ) {
    return invalid();
  }
  const claimed = await claimPreparedCardEnrollment(
    environment.DB,
    {
      userId: Schema.decodeSync(UserId)(session.user_id),
      enrollmentId: input.enrollmentId,
      paymentRequestId: input.paymentRequestId,
      billingEmail: input.billingEmail,
      paymentSourceMode: input.paymentSourceMode,
    },
    now
  );
  if (!claimed) return json({ status: "source-verifying", enrollmentId: row.value.id });
  row = await enrollment(environment.DB, session.user_id, input.enrollmentId);
  if (Option.isNone(row)) return unavailable();
  if (input.paymentSourceMode === "reuse") {
    const source = decodeRow(
      Schema.Struct({ id: CardPaymentSourceId }),
      await environment.DB.prepare("SELECT id FROM card_payment_sources WHERE user_id = ?")
        .bind(session.user_id)
        .first()
    );
    return Option.isSome(source)
      ? finish(
          environment,
          session.user_id,
          row.value,
          input.paymentRequestId,
          session,
          source.value.id,
          now
        )
      : unavailable();
  }
  const wompi = await makeWompi(environment);
  const fresh = await Effect.runPromiseExit(wompi.contracts(DateTime.makeUnsafe(now)));
  if (Exit.isFailure(fresh)) {
    await environment.DB.prepare(
      "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-error' WHERE id = ? AND status = 'creating'"
    )
      .bind(row.value.id)
      .run();
    return unavailable();
  }
  const old = parse(Schema.toCodecJson(WompiContractEvidenceSet), row.value.contracts_json);
  const current = fresh.value.evidence;
  if (
    Option.isNone(old) ||
    old.value.endUserPolicy.contentSha256 !== current.endUserPolicy.contentSha256 ||
    old.value.endUserPolicy.providerContentHash !== current.endUserPolicy.providerContentHash ||
    old.value.personalDataAuthorization.contentSha256 !==
      current.personalDataAuthorization.contentSha256 ||
    old.value.personalDataAuthorization.providerContentHash !==
      current.personalDataAuthorization.providerContentHash
  ) {
    await environment.DB.prepare(
      "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'terms-changed' WHERE id = ? AND status = 'creating'"
    )
      .bind(row.value.id)
      .run();
    return json({ status: "refused", enrollmentId: row.value.id, reason: "terms-changed" });
  }
  const source = await Effect.runPromiseExit(
    wompi.createPaymentSource({
      cardToken: input.cardToken,
      billingEmail: input.billingEmail,
      contracts: fresh.value,
    })
  );
  if (Exit.isFailure(source)) {
    await environment.DB.prepare(
      "UPDATE card_enrollments SET status = 'verifying' WHERE id = ? AND status = 'creating'"
    )
      .bind(row.value.id)
      .run();
    return json({ status: "source-verifying", enrollmentId: row.value.id });
  }
  if (source.value._tag === "Refused") {
    await environment.DB.prepare(
      "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-declined' WHERE id = ? AND status = 'creating'"
    )
      .bind(row.value.id)
      .run();
    return json({ status: "refused", enrollmentId: row.value.id, reason: "provider-declined" });
  }
  const candidate = await environment.DB.prepare(`UPDATE card_enrollments
    SET status = 'verifying', wompi_candidate_source_id = ?
    WHERE id = ? AND user_id = ? AND status = 'creating' AND payment_request_id = ?`)
    .bind(source.value.sourceId, row.value.id, session.user_id, input.paymentRequestId)
    .run();
  if (candidate.meta.changes !== 1) return unavailable();
  const pending = await enrollment(environment.DB, session.user_id, row.value.id);
  return Option.isSome(pending)
    ? resolveCandidate(environment, session, pending.value, now)
    : unavailable();
};

/** Exact-origin fresh-session direct browser boundary; provider identity never leaves Core. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const handleCardEnrollment = async (
  request: Request,
  environment: EnrollmentEnvironment
): Promise<Response> => {
  const config = decodeRow(WompiConfiguration, environment);
  if (
    Option.isNone(config) ||
    (config.value.WOMPI_ENVIRONMENT === "sandbox"
      ? !config.value.WOMPI_PUBLIC_KEY.startsWith("pub_test_") ||
        !config.value.WOMPI_PRIVATE_KEY.startsWith("prv_test_") ||
        !config.value.WOMPI_INTEGRITY_SECRET.startsWith("test_integrity_")
      : !config.value.WOMPI_PUBLIC_KEY.startsWith("pub_prod_") ||
        !config.value.WOMPI_PRIVATE_KEY.startsWith("prv_prod_") ||
        !config.value.WOMPI_INTEGRITY_SECRET.startsWith("prod_integrity_"))
  ) {
    return unavailable();
  }
  const configured = { ...environment, ...config.value };
  if (request.headers.get("origin") !== configured.BROWSER_ORIGIN) return invalid(forbiddenStatus);
  // @effect-diagnostics-next-line globalDate:off
  const now = Date.now();
  try {
    const session = await authority(request, environment.DB, now);
    if (Option.isNone(session)) return invalid(unauthorizedStatus);
    const path = new URL(request.url).pathname;
    if (path === "/web/subscription/card-enrollments/prepare" && request.method === "POST") {
      return await prepare(request, session.value, configured, now);
    }
    if (path === "/web/subscription/card-enrollments/submit" && request.method === "POST") {
      return await submit(request, session.value, configured, now);
    }
    const match = uuidPath.exec(path);
    if (match !== null && request.method === "GET") {
      if (path.startsWith("/web/subscription/billing-attempts/")) {
        const attempt = await attemptFor(environment.DB, session.value.user_id, match[1] ?? "");
        return Option.isSome(attempt)
          ? json(Schema.encodeSync(Schema.toCodecJson(BillingAttempt))(attempt.value))
          : invalid();
      }
      const row = await enrollment(environment.DB, session.value.user_id, match[1] ?? "");
      if (Option.isNone(row)) return invalid();
      if (row.value.status === "preparing") return unavailable();
      const selected = await price(environment.DB, row.value.price_id);
      return Option.isSome(selected)
        ? json(
            Schema.encodeSync(Schema.toCodecJson(CardEnrollment))(
              project(row.value, selected.value, configured.WOMPI_PUBLIC_KEY)
            )
          )
        : unavailable();
    }
    return invalid();
  } catch {
    return unavailable();
  }
};
