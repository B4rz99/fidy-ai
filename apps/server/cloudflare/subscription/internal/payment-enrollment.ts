import { verifiedEmailQuery } from "../../email-authentication/operations";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { authenticateWebSession } from "../../web-session/operations";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { freshSessionQuery } from "../../../src/shell/web-session/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { UserContext, UserId } from "../../../src/core/identity/contract";
import { prepareUserContext } from "../../identity/user-context/operations";
import {
  BillingAttempt,
  BillingAttemptId,
  BillingEmail,
  DaviplataOtpPolicy,
  EnrollmentAvailability,
  EnrollmentMethod,
  PaymentEnrollment,
  PaymentEnrollmentId,
  PaymentRequestId,
  PaymentSubmission,
  Price,
  RecurringDisclosure,
  WompiContractEvidenceSet,
} from "../../../src/core/subscription/contract";
import { PaymentSourceId, WompiSourceId } from "./wompi-model";
import {
  PreparePaymentEnrollmentPayload,
  SubmitPaymentEnrollmentPayload,
  paymentEnrollmentInvalidBody,
  paymentEnrollmentRateLimitedBody,
  paymentEnrollmentUnavailableBody,
} from "../../../src/shell/subscription/contract";
import { type WompiEnrollmentClientService, makeWompiEnrollmentClient } from "./wompi-client";
import {
  Cause,
  Clock,
  Data,
  DateTime,
  Effect,
  Exit,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { Hex } from "effect/encoding";

import { claimPreparedPaymentEnrollment } from "./payment-enrollment-claim";
import { admitEnrollmentAttempt } from "./enrollment-admission";
import { ResourceAdmissionRefused } from "../../resource-admission/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";
import { browserOrigins } from "../../runtime/contract";
import { wompiOutboundHttp, workerCrypto } from "./wompi-runtime";
import { type EnrollmentEnvironment } from "../contract";

const Origin = Schema.Literals([
  browserOrigins.production,
  browserOrigins.local,
  browserOrigins.acceptance,
]);
const WompiConfiguration = Schema.Struct({
  BROWSER_ORIGIN: Origin,
  WOMPI_ENVIRONMENT: WompiEnvironment,
  WOMPI_PUBLIC_KEY: Schema.String.check(Schema.isPattern(/^pub_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)),
  WOMPI_PRIVATE_KEY: Schema.String.check(
    Schema.isPattern(/^prv_(?:test|prod)_[A-Za-z0-9_-]{8,}$/u)
  ),
  WOMPI_INTEGRITY_SECRET: Schema.String.check(
    Schema.isPattern(/^(?:test|prod)_integrity_[A-Za-z0-9_-]{8,}$/u)
  ),
});
const Session = Schema.Struct({
  session_id: Schema.String,
  user_id: UserId,
  timeZone: UserContext.fields.timeZone,
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
  id: PaymentEnrollmentId,
  user_id: UserId,
  price_id: Price.fields.id,
  billing_email: BillingEmail,
  method: EnrollmentMethod,
  wompi_environment: Schema.NullOr(WompiEnvironment),
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
  ends_at_ms: Schema.NullOr(Schema.Finite),
  renewal_anchor_ms: Schema.NullOr(Schema.Finite),
});
const enrollmentDisclosureRevisions = {
  card: "wompi-card-enrollment-v1",
  nequi: "wompi-nequi-enrollment-v1",
  daviplata: "wompi-daviplata-enrollment-v1",
} as const satisfies Readonly<Record<EnrollmentMethod, RecurringDisclosure["revision"]>>;

const submittedToken = (
  input: Extract<SubmitPaymentEnrollmentPayload, { paymentSourceMode: "create" }>
): Redacted.Redacted<string> => {
  switch (input.method) {
    case "card":
      return input.cardToken;
    case "nequi":
      return input.nequiToken;
    case "daviplata":
      return input.daviplataToken;
  }
};

const walletTokenPatterns = {
  sandbox: { nequi: /^nequi_test_/u, daviplata: /^daviplata_(?:devtest|devint)_/u },
  production: { nequi: /^nequi_prod_/u, daviplata: /^daviplata_prod_/u },
} as const;

const preparationWindowMs = 3_600_000;
const verificationCooldownMs = 3_000;
const maximumVerificationAttempts = 8;
const maximumPreparationsPerHour = 12;
const enrollmentLifetimeMs = 900_000;
const hexBase = 16;
const uuidByteCount = 16;
const uuidVersionByte = 6;
const uuidVariantByte = 8;
const versionMask = 0x0f;
const versionBits = 0x40;
const variantMask = 0x3f;
const variantBits = 0x80;
const firstGroupEnd = 8;
const secondGroupEnd = 12;
const thirdGroupEnd = 16;
const fourthGroupEnd = 20;
const billingInsertResultFromEnd = -2;
const forbiddenStatus = 403;
const unauthorizedStatus = 401;
const uuidPath =
  /^\/web\/subscription\/(?:payment-enrollments|billing-attempts)\/([0-9a-f-]{36})$/u;
const jsonPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 6144,
  deadlineMilliseconds: 2000,
});
const noStore = { "cache-control": "no-store" };
const invalid = (status = 400): Response =>
  Response.json(paymentEnrollmentInvalidBody, { status, headers: noStore });
const unavailable = (): Response =>
  Response.json(paymentEnrollmentUnavailableBody, { status: 503, headers: noStore });
const rateLimited = (): Response =>
  Response.json(paymentEnrollmentRateLimitedBody, { status: 429, headers: noStore });
const json = (body: unknown): Response => Response.json(body, { headers: noStore });
const instant = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const id = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
const digest = (text: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((bytes) => new Uint8Array(bytes));

/** Derive one BillingAttempt ID from the authenticated User and the validated, retry-stable PaymentRequestId for a single payment action. Never use a new PaymentRequestId to retry the same action. */
export const billingAttemptIdFor = (
  input: Readonly<{ userId: UserId; requestId: PaymentRequestId }>
): Promise<BillingAttemptId> =>
  digest(`billing-attempt-v1:${input.userId}:${input.requestId}`).then((hash) => {
    const bytes = hash.slice(0, uuidByteCount);
    // The digest supplies the identity; UUID version/variant bits preserve the public ID contract.
    bytes[uuidVersionByte] = ((bytes[uuidVersionByte] ?? 0) & versionMask) | versionBits;
    bytes[uuidVariantByte] = ((bytes[uuidVariantByte] ?? 0) & variantMask) | variantBits;
    const hex = Array.from(bytes, (byte) => byte.toString(hexBase).padStart(2, "0")).join("");
    return BillingAttemptId.make(
      `${hex.slice(0, firstGroupEnd)}-${hex.slice(firstGroupEnd, secondGroupEnd)}-${hex.slice(secondGroupEnd, thirdGroupEnd)}-${hex.slice(thirdGroupEnd, fourthGroupEnd)}-${hex.slice(fourthGroupEnd)}`
    );
  });
const decodeJson = (text: string): unknown => JSON.parse(text);
const parse = <A, E>(schema: Schema.Codec<A, E>, text: string): Option.Option<A> =>
  Schema.decodeUnknownOption(schema, { onExcessProperty: "error" })(decodeJson(text));
const decodeRow = <A, E>(schema: Schema.Codec<A, E>, row: unknown): Option.Option<A> =>
  Schema.decodeUnknownOption(schema)(row);

type ConfiguredEnrollmentEnvironment = typeof WompiConfiguration.Type & EnrollmentEnvironment;

const daviplataPolicy = (
  environment: EnrollmentEnvironment & { readonly WOMPI_ENVIRONMENT: string }
): Option.Option<DaviplataOtpPolicy> => {
  if (
    environment.WOMPI_ENVIRONMENT === "production" &&
    environment.WOMPI_DAVIPLATA_ACTIVATED !== "enabled"
  ) {
    return Option.none();
  }
  const policy = Schema.decodeUnknownOption(DaviplataOtpPolicy)({
    sendUrl: environment.WOMPI_DAVIPLATA_OTP_SEND_URL,
    confirmUrl: environment.WOMPI_DAVIPLATA_OTP_CONFIRM_URL,
  });
  const origin =
    environment.WOMPI_ENVIRONMENT === "sandbox"
      ? "https://sandbox.wompi.co/"
      : "https://production.wompi.co/";
  return Option.filter(
    policy,
    (value) => value.sendUrl.startsWith(origin) && value.confirmUrl.startsWith(origin)
  );
};

const makeWompi = (
  environment: ConfiguredEnrollmentEnvironment
): Promise<WompiEnrollmentClientService> =>
  Effect.runPromise(wompiOutboundHttp(environment)).then((outboundHttp) =>
    makeWompiEnrollmentClient({
      outboundHttp,
      crypto: workerCrypto,
      publicKey: environment.WOMPI_PUBLIC_KEY,
    })
  );

const authority = (
  request: Request,
  db: D1Database,
  at: number
): Promise<Option.Option<typeof Session.Type>> =>
  authenticateWebSession({ request, db, current: at, freshness: "fresh" }).then((subject) => {
    if (Option.isNone(subject)) return Option.none<typeof Session.Type>();
    const session = freshSessionQuery({
      subject: {
        sql: "SELECT ? AS sessionId, ? AS userId",
        params: [subject.value.id, subject.value.userId],
      },
      current: at,
    });
    const email = verifiedEmailQuery({ userId: UserId.make(subject.value.userId) });
    return prepareUserContext({
      db,
      userId: UserId.make(subject.value.userId),
      statement: protectConsentStatement({
        statement: {
          sql: `SELECT s.id AS session_id, s.userId AS user_id, u.timeZone, v.emailAddress AS email_address FROM (${session.sql}) AS s
            JOIN identity_user_context AS u ON u.userId = s.userId
            JOIN (${email.sql}) AS v ON v.userId = s.userId WHERE 1 = 1`,
          params: [...session.params, ...email.params],
        },
        subject: { _tag: "User", userId: subject.value.userId },
        requirement: "active",
      }),
    })
      .first()
      .then((row) => decodeRow(Session, row));
  });

const enrollmentAuthority = (session: typeof Session.Type, now: number): OwnedStatement => {
  const fresh = freshSessionQuery({
    subject: {
      sql: "SELECT ? AS sessionId, ? AS userId",
      params: [session.session_id, session.user_id],
    },
    current: now,
  });
  return protectConsentStatement({
    statement: fresh,
    subject: { _tag: "User", userId: session.user_id },
    requirement: "active",
  });
};

const price = (db: D1Database, priceId: string): Promise<Option.Option<Price>> =>
  db
    .prepare(`SELECT id, amount, currency, billing_period,
    service_market, tax_treatment, terms_json FROM subscription_prices WHERE id = ?`)
    .bind(priceId)
    .first()
    .then((raw) => {
      const row = decodeRow(PriceRow, raw);
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
    });

const enrollment = (
  db: D1Database,
  userId: string,
  enrollmentId: string
): Promise<Option.Option<typeof EnrollmentRow.Type>> =>
  db
    .prepare("SELECT * FROM card_enrollments WHERE id = ? AND user_id = ?")
    .bind(enrollmentId, userId)
    .first()
    .then((row) => decodeRow(EnrollmentRow, row));

const project = (
  row: typeof EnrollmentRow.Type,
  selectedPrice: Price,
  environment: ConfiguredEnrollmentEnvironment
): PaymentEnrollment => {
  switch (row.status) {
    case "prepared": {
      const contracts = parse(Schema.toCodecJson(WompiContractEvidenceSet), row.contracts_json);
      const disclosure = parse(Schema.toCodecJson(RecurringDisclosure), row.disclosure_json);
      if (Option.isNone(contracts) || Option.isNone(disclosure)) {
        throw new Error("invalid enrollment evidence");
      }
      const prepared = {
        status: "prepared" as const,
        enrollmentId: row.id,
        price: selectedPrice,
        billingEmail: row.billing_email,
        contracts: contracts.value,
        recurringDisclosure: disclosure.value,
        wompiPublicKey: environment.WOMPI_PUBLIC_KEY,
        paymentSourceMode: row.payment_source_mode,
        expiresAt: DateTime.makeUnsafe(row.expires_at_ms),
      };
      if (row.method !== "daviplata") return { ...prepared, method: row.method };
      const policy = daviplataPolicy(environment);
      if (Option.isNone(policy)) throw new Error("DaviPlata authorization unavailable");
      return { ...prepared, method: "daviplata", daviplataOtpPolicy: policy.value };
    }
    case "preparing":
      throw new Error("preparation is not ready");
    case "refused":
      return {
        status: "refused",
        enrollmentId: row.id,
        method: row.method,
        priceId: row.price_id,
        reason: row.refusal_reason ?? "provider-error",
      };
    case "creating":
    case "available":
    case "expired":
    case "verifying":
      return {
        status: row.status,
        enrollmentId: row.id,
        method: row.method,
        priceId: row.price_id,
      };
  }
};

const readBody = <A, E>(
  request: Request,
  schema: Schema.Codec<A, E>
): Promise<Option.Option<A>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Promise.resolve(Option.none());
  }
  return Effect.runPromiseExit(readBoundedRequestBody(request, jsonPolicy)).then((result) => {
    if (Exit.isFailure(result)) return Option.none();
    try {
      return parse(schema, new TextDecoder("utf-8", { fatal: true }).decode(result.value));
    } catch {
      return Option.none();
    }
  });
};

const prepare = ({
  request,
  session,
  environment,
  now,
}: Readonly<{
  request: Request;
  session: typeof Session.Type;
  environment: ConfiguredEnrollmentEnvironment;
  now: number;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const body = yield* waitFor(() => readBody(request, PreparePaymentEnrollmentPayload));
      if (Option.isNone(body)) return invalid();
      if (body.value.method === "daviplata" && Option.isNone(daviplataPolicy(environment))) {
        return unavailable();
      }
      const selected = yield* waitFor(() => price(environment.DB, body.value.priceId));
      if (Option.isNone(selected)) return invalid();
      const incompatibleSource = yield* waitFor(() =>
        environment.DB.prepare(
          `SELECT s.id FROM card_payment_sources AS s WHERE s.user_id = ? AND (s.method <> ?
            OR NOT EXISTS (SELECT 1 FROM card_enrollments AS origin WHERE origin.id = s.enrollment_id
              AND (origin.wompi_environment = ? OR (origin.wompi_environment IS NULL AND EXISTS
                (SELECT 1 FROM billing_attempts AS a WHERE a.payment_source_id = s.id AND a.wompi_environment = ?))))
            OR EXISTS (SELECT 1 FROM billing_attempts AS a WHERE a.payment_source_id = s.id AND a.wompi_environment <> ?))`
        )
          .bind(
            session.user_id,
            body.value.method,
            environment.WOMPI_ENVIRONMENT,
            environment.WOMPI_ENVIRONMENT,
            environment.WOMPI_ENVIRONMENT
          )
          .first()
      );
      if (incompatibleSource !== null) return invalid();
      const active = yield* waitFor(() =>
        environment.DB.prepare(`SELECT id FROM card_enrollments WHERE user_id = ?
    AND status IN ('preparing', 'prepared', 'creating', 'verifying') ORDER BY prepared_at_ms DESC LIMIT 1`)
          .bind(session.user_id)
          .first()
      );
      const activeId = decodeRow(Schema.Struct({ id: PaymentEnrollmentId }), active);
      if (Option.isSome(activeId)) {
        const existing = yield* waitFor(() =>
          enrollment(environment.DB, session.user_id, activeId.value.id)
        );
        if (
          Option.isSome(existing) &&
          existing.value.price_id === selected.value.id &&
          existing.value.method === body.value.method &&
          existing.value.wompi_environment === environment.WOMPI_ENVIRONMENT &&
          existing.value.status === "prepared" &&
          existing.value.expires_at_ms > now
        ) {
          const presented = yield* Schema.encodeEffect(Schema.toCodecJson(PaymentEnrollment))(
            project(existing.value, selected.value, environment)
          );
          return json(presented);
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
          const activePrice = yield* waitFor(() => price(environment.DB, existing.value.price_id));
          if (Option.isNone(activePrice)) return unavailable();
          const presented = yield* Schema.encodeEffect(Schema.toCodecJson(PaymentEnrollment))(
            project(existing.value, activePrice.value, environment)
          );
          return json(presented);
        }
      }
      const attempt = yield* Effect.exit(
        admitEnrollmentAttempt({ db: environment.DB, userId: session.user_id, now })
      );
      if (Exit.isFailure(attempt)) {
        return Option.exists(
          Cause.findErrorOption(attempt.cause),
          (error) => error instanceof ResourceAdmissionRefused
        )
          ? rateLimited()
          : unavailable();
      }
      const capacity = yield* waitFor(() =>
        environment.DB.prepare(
          "SELECT count(*) AS count FROM card_enrollments WHERE user_id = ? AND prepared_at_ms > ?"
        )
          .bind(session.user_id, now - preparationWindowMs)
          .first()
      );
      if (
        !Schema.is(Schema.Struct({ count: Schema.Finite }))(capacity) ||
        capacity.count >= maximumPreparationsPerHour
      ) {
        return unavailable();
      }
      if (Option.isSome(activeId)) {
        yield* waitFor(() =>
          environment.DB.prepare(
            "UPDATE card_enrollments SET status = 'expired' WHERE id = ? AND user_id = ? AND status IN ('prepared', 'preparing')"
          )
            .bind(activeId.value.id, session.user_id)
            .run()
        );
      }
      const enrollmentId = PaymentEnrollmentId.make(id());
      const reserved = yield* waitFor(() =>
        environment.DB.prepare(`INSERT OR IGNORE INTO card_enrollments
    (id, user_id, price_id, billing_email, method, wompi_environment, status, payment_source_mode, contracts_json,
    disclosure_json, prepared_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'preparing', 'create', '{}', '{}', ?, ?)`)
          .bind(
            enrollmentId,
            session.user_id,
            selected.value.id,
            session.email_address,
            body.value.method,
            environment.WOMPI_ENVIRONMENT,
            now,
            now + enrollmentLifetimeMs
          )
          .run()
      );
      if (reserved.meta.changes !== 1) return unavailable();
      const wompi = yield* waitFor(() => makeWompi(environment));
      const contracts = yield* Effect.exit(wompi.contracts(DateTime.makeUnsafe(now)));
      if (Exit.isFailure(contracts)) {
        yield* waitFor(() =>
          environment.DB.prepare(
            "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-error' WHERE id = ? AND status = 'preparing'"
          )
            .bind(enrollmentId)
            .run()
        );
        return unavailable();
      }
      const statement = "Autorizo los cobros recurrentes de mi suscripción.";
      const disclosure = RecurringDisclosure.make({
        revision: enrollmentDisclosureRevisions[body.value.method],
        displayedText: statement,
        contentSha256: Array.from(yield* waitFor(() => digest(statement)), (byte) =>
          byte.toString(hexBase).padStart(2, "0")
        ).join(""),
      });
      const source = yield* waitFor(() =>
        environment.DB.prepare(
          "SELECT id FROM card_payment_sources WHERE user_id = ? AND method = ?"
        )
          .bind(session.user_id, body.value.method)
          .first()
      );
      const inserted = yield* waitFor(() =>
        environment.DB.prepare(`UPDATE card_enrollments
    SET status = 'prepared', payment_source_mode = ?, contracts_json = ?, disclosure_json = ?
    WHERE id = ? AND user_id = ? AND status = 'preparing'`)
          .bind(
            source === null ? "create" : "reuse",
            JSON.stringify(
              Schema.encodeSync(Schema.toCodecJson(WompiContractEvidenceSet))(
                contracts.value.evidence
              )
            ),
            JSON.stringify(Schema.encodeSync(Schema.toCodecJson(RecurringDisclosure))(disclosure)),
            enrollmentId,
            session.user_id
          )
          .run()
      );
      if (inserted.meta.changes !== 1) return unavailable();
      const retained = yield* waitFor(() =>
        enrollment(environment.DB, session.user_id, enrollmentId)
      );
      if (Option.isNone(retained)) return unavailable();
      const presented = yield* Schema.encodeEffect(Schema.toCodecJson(PaymentEnrollment))(
        project(retained.value, selected.value, environment)
      );
      return json(presented);
    })
  );

const attemptFor = (
  db: D1Database,
  userId: string,
  attemptId: string
): Promise<Option.Option<BillingAttempt>> =>
  db
    .prepare(`SELECT a.*, p.ends_at_ms, p.renewal_anchor_ms FROM billing_attempts AS a
      LEFT JOIN billing_paid_periods AS p ON p.attempt_id = a.id
      WHERE a.id = ? AND a.user_id = ?`)
    .bind(attemptId, userId)
    .first()
    .then((raw) => {
      const row = decodeRow(AttemptRow, raw);
      if (Option.isNone(row)) return Option.none();
      const snapshot = {
        id: row.value.id,
        priceId: row.value.price_id,
        money: { amount: row.value.amount, currency: row.value.currency },
        billingPeriod: row.value.billing_period,
        serviceMarket: row.value.service_market,
        taxTreatment: row.value.tax_treatment,
        timeZone: row.value.time_zone,
        createdAt: instant(row.value.created_at_ms),
      };
      if (row.value.status === "pending") {
        return decodeRow(Schema.toCodecJson(BillingAttempt), { status: "pending", ...snapshot });
      }
      if (row.value.finalized_at_ms === null) return Option.none();
      if (row.value.status === "failed") {
        return decodeRow(Schema.toCodecJson(BillingAttempt), {
          status: "failed",
          ...snapshot,
          failedAt: instant(row.value.finalized_at_ms),
        });
      }
      if (row.value.ends_at_ms === null || row.value.renewal_anchor_ms === null) {
        return Option.none();
      }
      return decodeRow(Schema.toCodecJson(BillingAttempt), {
        status: "succeeded",
        ...snapshot,
        finalizedAt: instant(row.value.finalized_at_ms),
        paidPeriodEndsAt: instant(row.value.ends_at_ms),
        renewalAnchor: instant(row.value.renewal_anchor_ms),
      });
    });

class EnrollmentBoundaryFailure extends Data.TaggedError("EnrollmentBoundaryFailure")<{
  readonly cause: unknown;
}> {}
const waitFor = <A>(run: () => Promise<A>): Effect.Effect<A, EnrollmentBoundaryFailure> =>
  Effect.tryPromise({ try: run, catch: (cause) => new EnrollmentBoundaryFailure({ cause }) });

const finish = ({
  environment,
  userId,
  row,
  requestId,
  session,
  sourceId,
  now,
  wompiSourceId,
}: Readonly<{
  environment: ConfiguredEnrollmentEnvironment;
  userId: string;
  row: typeof EnrollmentRow.Type;
  requestId: string;
  session: typeof Session.Type;
  sourceId: string;
  now: number;
  wompiSourceId: Option.Option<number>;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const selected = yield* waitFor(() => price(environment.DB, row.price_id));
      if (Option.isNone(selected)) return unavailable();
      const attemptId = yield* waitFor(() =>
        billingAttemptIdFor({
          userId: UserId.make(userId),
          requestId: PaymentRequestId.make(requestId),
        })
      );
      const reference = `fidy-${attemptId}`;
      const current = yield* Clock.currentTimeMillis;
      const guard = enrollmentAuthority(session, current);
      const statements = [
        environment.DB.prepare(`INSERT INTO payment_commit_guards (enrollment_id, allowed)
          VALUES (?, (SELECT 1 FROM (${guard.sql}) LIMIT 1))`).bind(row.id, ...guard.params),
        ...(Option.isNone(wompiSourceId)
          ? []
          : [
              environment.DB.prepare(`INSERT INTO card_payment_sources
      (id, user_id, enrollment_id, wompi_source_id, billing_email, created_at_ms, method)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
                sourceId,
                userId,
                row.id,
                wompiSourceId.value,
                row.billing_email,
                now,
                row.method
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
          session.timeZone,
          environment.WOMPI_ENVIRONMENT,
          reference,
          now,
          row.id,
          userId,
          requestId
        ),
      ];
      const committed = yield* waitFor(() =>
        environment.DB.batch([
          ...statements,
          environment.DB.prepare("DELETE FROM payment_commit_guards WHERE enrollment_id = ?").bind(
            row.id
          ),
        ])
      );
      // D1 counts the arm and outbox trigger writes alongside the BillingAttempt insertion.
      if ((committed.at(billingInsertResultFromEnd)?.meta.changes ?? 0) === 0) return unavailable();
      environment.onAccepted(attemptId);
      const attempt = yield* waitFor(() => attemptFor(environment.DB, userId, attemptId));
      if (Option.isNone(attempt)) return unavailable();
      const presented = yield* Schema.encodeEffect(Schema.toCodecJson(PaymentSubmission))({
        status: "payment-pending",
        enrollmentId: row.id,
        billingAttempt: attempt.value,
      });
      return json(presented);
    })
  );

const resolveCandidate = ({
  environment,
  session,
  row,
  now,
}: Readonly<{
  environment: ConfiguredEnrollmentEnvironment;
  session: typeof Session.Type;
  row: typeof EnrollmentRow.Type;
  now: number;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const candidate = row.wompi_candidate_source_id;
      if (candidate === null || row.payment_request_id === null) {
        return json({ status: "source-verifying", enrollmentId: row.id });
      }
      const claimedLookup = yield* waitFor(() =>
        environment.DB.prepare(`UPDATE card_enrollments
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
          .run()
      );
      if (claimedLookup.meta.changes !== 1) {
        return json({ status: "source-verifying", enrollmentId: row.id });
      }
      const wompi = yield* waitFor(() => makeWompi(environment));
      const verified = yield* Effect.exit(
        wompi.verifyPaymentSource(WompiSourceId.make(candidate), row.method)
      );
      if (Exit.isFailure(verified) || verified.value.sourceId !== candidate) {
        return json({ status: "source-verifying", enrollmentId: row.id });
      }
      if (verified.value.billingEmail !== row.billing_email) {
        yield* waitFor(() =>
          environment.DB.prepare(
            "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-error' WHERE id = ? AND user_id = ? AND status = 'verifying'"
          )
            .bind(row.id, session.user_id)
            .run()
        );
        return json({ status: "refused", enrollmentId: row.id, reason: "provider-error" });
      }
      const requestId = row.payment_request_id;
      return yield* waitFor(() =>
        finish({
          environment,
          userId: session.user_id,
          row,
          requestId,
          session,
          sourceId: PaymentSourceId.make(id()),
          now,
          wompiSourceId: Option.some(candidate),
        })
      );
    })
  );

const verifyEnrollmentAuthorization = (
  context: Readonly<{
    environment: ConfiguredEnrollmentEnvironment;
    userId: string;
    input: SubmitPaymentEnrollmentPayload;
    method: EnrollmentMethod;
    now: number;
  }>
): Effect.Effect<Result.Result<Option.Option<string>, Response>, EnrollmentBoundaryFailure> =>
  Effect.gen(function* () {
    const { environment, input, userId, now } = context;
    if (context.method === "daviplata" && Option.isNone(daviplataPolicy(environment))) {
      return Result.fail(unavailable());
    }
    if (input.paymentSourceMode !== "create" || input.method === "card") {
      return Result.succeed(Option.none());
    }
    const token = submittedToken(input);
    const tokenPattern = walletTokenPatterns[environment.WOMPI_ENVIRONMENT][input.method];
    if (!tokenPattern.test(Redacted.value(token))) return Result.fail(invalid());
    const admission = yield* Effect.result(
      admitEnrollmentAttempt({ db: environment.DB, userId, now })
    );
    if (Result.isFailure(admission)) {
      return Result.fail(
        admission.failure._tag === "ResourceAdmissionRefused" ? rateLimited() : unavailable()
      );
    }
    const wompi = yield* waitFor(() => makeWompi(environment));
    const approved = yield* Effect.exit(
      input.method === "nequi"
        ? wompi.verifyNequiApproval(token)
        : wompi.verifyDaviplataApproval(token)
    );
    if (Exit.isFailure(approved)) return Result.fail(unavailable());
    if (!approved.value) return Result.fail(invalid());
    return Result.succeed(
      Option.some(
        Hex.encode(
          yield* waitFor(() => digest(`${environment.WOMPI_ENVIRONMENT}:${Redacted.value(token)}`))
        )
      )
    );
  });

const authorizeSourcePost = (
  input: Readonly<{ db: D1Database; session: typeof Session.Type; enrollmentId: string }>
): Effect.Effect<boolean, EnrollmentBoundaryFailure> =>
  Effect.gen(function* () {
    const guard = enrollmentAuthority(input.session, yield* Clock.currentTimeMillis);
    const live = yield* waitFor(() =>
      input.db
        .prepare(guard.sql)
        .bind(...guard.params)
        .first()
    );
    if (live !== null) return true;
    // No source POST has started: retire this claim as a known refusal, never as ambiguous work.
    yield* waitFor(() =>
      input.db
        .prepare(
          "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-error' WHERE id = ? AND user_id = ? AND status = 'creating'"
        )
        .bind(input.enrollmentId, input.session.user_id)
        .run()
    );
    return false;
  });

const deniedClaimResponse = (
  input: Readonly<{ db: D1Database; userId: string; enrollmentId: string }>
): Effect.Effect<Response, EnrollmentBoundaryFailure> =>
  waitFor(() => enrollment(input.db, input.userId, input.enrollmentId)).pipe(
    Effect.map((row) =>
      Option.isSome(row) && ["creating", "verifying", "debit_pending"].includes(row.value.status)
        ? json({ status: "source-verifying", enrollmentId: row.value.id })
        : invalid()
    )
  );

const submit = ({
  request,
  session,
  environment,
  now,
}: Readonly<{
  request: Request;
  session: typeof Session.Type;
  environment: ConfiguredEnrollmentEnvironment;
  now: number;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const body = yield* waitFor(() => readBody(request, SubmitPaymentEnrollmentPayload));
      if (Option.isNone(body)) return invalid();
      const input = body.value;
      let row = yield* waitFor(() =>
        enrollment(environment.DB, session.user_id, input.enrollmentId)
      );
      if (Option.isNone(row) || row.value.wompi_environment !== environment.WOMPI_ENVIRONMENT) {
        return invalid();
      }
      if (
        row.value.payment_request_id !== null &&
        row.value.payment_request_id !== input.paymentRequestId
      ) {
        return invalid();
      }
      const existing = yield* waitFor(() =>
        environment.DB.prepare(
          "SELECT id, enrollment_id FROM billing_attempts WHERE user_id = ? AND payment_request_id = ?"
        )
          .bind(session.user_id, input.paymentRequestId)
          .first()
      );
      const existingId = decodeRow(
        Schema.Struct({ id: BillingAttemptId, enrollment_id: PaymentEnrollmentId }),
        existing
      );
      if (Option.isSome(existingId)) {
        if (existingId.value.enrollment_id !== row.value.id) return invalid();
        const attempt = yield* waitFor(() =>
          attemptFor(environment.DB, session.user_id, existingId.value.id)
        );
        if (Option.isNone(attempt)) return invalid();
        const presented = yield* Schema.encodeEffect(Schema.toCodecJson(PaymentSubmission))({
          status: "payment-pending",
          enrollmentId: row.value.id,
          billingAttempt: attempt.value,
        });
        return json(presented);
      }
      // The same PaymentRequestId was handled above; a different action cannot collect
      // while this User has an attempt without success or confirmed no-charge evidence.
      const blocked = yield* waitFor(() =>
        environment.DB.prepare(`SELECT 1 AS blocked FROM billing_attempts AS a
      WHERE a.user_id = ? AND a.status <> 'succeeded'
        AND NOT EXISTS (SELECT 1 FROM billing_no_charge_confirmations AS c
          WHERE c.attempt_id = a.id) LIMIT 1`)
          .bind(session.user_id)
          .first()
      );
      if (blocked !== null) return unavailable();
      if (row.value.status === "creating") {
        return json({ status: "source-verifying", enrollmentId: row.value.id });
      }
      if (row.value.status === "verifying") {
        const verifying = row.value;
        return yield* waitFor(() =>
          resolveCandidate({ environment, session, row: verifying, now })
        );
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
      if (input.paymentSourceMode === "create" && input.method !== row.value.method) {
        return invalid();
      }
      const authorization = yield* verifyEnrollmentAuthorization({
        environment,
        userId: session.user_id,
        input,
        method: row.value.method,
        now,
      });
      if (Result.isFailure(authorization)) return authorization.failure;
      const authorizationDigest = authorization.success;
      const userId = yield* Schema.decodeEffect(UserId)(session.user_id);
      const claimedAt = yield* Clock.currentTimeMillis;
      const claimed = yield* waitFor(() =>
        claimPreparedPaymentEnrollment({
          db: environment.DB,
          authorityGuard: enrollmentAuthority(session, claimedAt),
          input: {
            userId,
            enrollmentId: input.enrollmentId,
            paymentRequestId: input.paymentRequestId,
            billingEmail: input.billingEmail,
            paymentSourceMode: input.paymentSourceMode,
            ...(Option.isNone(authorizationDigest)
              ? {}
              : { authorizationDigest: authorizationDigest.value }),
          },
          claimedAtMs: claimedAt,
        })
      );
      if (!claimed) {
        return yield* deniedClaimResponse({
          db: environment.DB,
          userId: session.user_id,
          enrollmentId: input.enrollmentId,
        });
      }
      row = yield* waitFor(() => enrollment(environment.DB, session.user_id, input.enrollmentId));
      if (Option.isNone(row)) return unavailable();
      const retained = row.value;
      if (input.paymentSourceMode === "reuse") {
        const source = decodeRow(
          Schema.Struct({ id: PaymentSourceId }),
          yield* waitFor(() =>
            environment.DB.prepare(
              "SELECT id FROM card_payment_sources WHERE user_id = ? AND method = ?"
            )
              .bind(session.user_id, retained.method)
              .first()
          )
        );
        if (Option.isNone(source)) return unavailable();
        return yield* waitFor(() =>
          finish({
            environment,
            userId: session.user_id,
            row: retained,
            requestId: input.paymentRequestId,
            session,
            sourceId: source.value.id,
            now,
            wompiSourceId: Option.none(),
          })
        );
      }
      const wompi = yield* waitFor(() => makeWompi(environment));
      const fresh = yield* Effect.exit(wompi.contracts(DateTime.makeUnsafe(now)));
      if (Exit.isFailure(fresh)) {
        yield* waitFor(() =>
          environment.DB.prepare(
            "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-error' WHERE id = ? AND status = 'creating'"
          )
            .bind(row.value.id)
            .run()
        );
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
        yield* waitFor(() =>
          environment.DB.prepare(
            "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'terms-changed' WHERE id = ? AND status = 'creating'"
          )
            .bind(row.value.id)
            .run()
        );
        return json({ status: "refused", enrollmentId: row.value.id, reason: "terms-changed" });
      }
      if (
        !(yield* authorizeSourcePost({ db: environment.DB, session, enrollmentId: row.value.id }))
      ) {
        return invalid();
      }
      const source = yield* Effect.exit(
        wompi.createPaymentSource({
          token: submittedToken(input),
          method: input.method,
          billingEmail: input.billingEmail,
          contracts: fresh.value,
        })
      );
      if (Exit.isFailure(source)) {
        yield* waitFor(() =>
          environment.DB.prepare(
            "UPDATE card_enrollments SET status = 'verifying' WHERE id = ? AND status = 'creating'"
          )
            .bind(row.value.id)
            .run()
        );
        return json({ status: "source-verifying", enrollmentId: row.value.id });
      }
      if (source.value._tag === "Refused") {
        yield* waitFor(() =>
          environment.DB.prepare(
            "UPDATE card_enrollments SET status = 'refused', refusal_reason = 'provider-declined' WHERE id = ? AND status = 'creating'"
          )
            .bind(row.value.id)
            .run()
        );
        return json({ status: "refused", enrollmentId: row.value.id, reason: "provider-declined" });
      }
      const createdSourceId = source.value.sourceId;
      const candidate = yield* waitFor(() =>
        environment.DB.prepare(`UPDATE card_enrollments
    SET status = 'verifying', wompi_candidate_source_id = ?
    WHERE id = ? AND user_id = ? AND status = 'creating' AND payment_request_id = ?`)
          .bind(createdSourceId, retained.id, session.user_id, input.paymentRequestId)
          .run()
      );
      if (candidate.meta.changes !== 1) return unavailable();
      const pending = yield* waitFor(() =>
        enrollment(environment.DB, session.user_id, row.value.id)
      );
      return Option.isSome(pending)
        ? yield* waitFor(() => resolveCandidate({ environment, session, row: pending.value, now }))
        : unavailable();
    })
  );

/** Exact-origin fresh-session direct browser boundary; provider identity never leaves Core. */
export const handlePaymentEnrollment = ({
  request,
  environment,
}: {
  request: Request;
  environment: EnrollmentEnvironment;
}): Promise<Response> => {
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
    return Promise.resolve(unavailable());
  }
  const configured = { ...environment, ...config.value };
  if (request.headers.get("origin") !== configured.BROWSER_ORIGIN) {
    return Promise.resolve(invalid(forbiddenStatus));
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const session = yield* waitFor(() => authority(request, environment.DB, now));
      if (Option.isNone(session)) return invalid(unauthorizedStatus);
      const path = new URL(request.url).pathname;
      if (
        path === "/web/subscription/payment-enrollments/availability" &&
        request.method === "GET"
      ) {
        const availability = EnrollmentAvailability.make({
          enabledMethods: Option.isSome(daviplataPolicy(configured))
            ? ["card", "nequi", "daviplata"]
            : ["card", "nequi"],
        });
        return json(
          yield* Schema.encodeEffect(Schema.toCodecJson(EnrollmentAvailability))(availability)
        );
      }
      if (path === "/web/subscription/payment-enrollments/prepare" && request.method === "POST") {
        return yield* waitFor(() =>
          prepare({ request, session: session.value, environment: configured, now })
        );
      }
      if (path === "/web/subscription/payment-enrollments/submit" && request.method === "POST") {
        return yield* waitFor(() =>
          submit({ request, session: session.value, environment: configured, now })
        );
      }
      const match = uuidPath.exec(path);
      if (match !== null && request.method === "GET") {
        if (path.startsWith("/web/subscription/billing-attempts/")) {
          const attempt = yield* waitFor(() =>
            attemptFor(environment.DB, session.value.user_id, match[1] ?? "")
          );
          if (Option.isNone(attempt)) return invalid();
          return json(
            yield* Schema.encodeEffect(Schema.toCodecJson(BillingAttempt))(attempt.value)
          );
        }
        const row = yield* waitFor(() =>
          enrollment(environment.DB, session.value.user_id, match[1] ?? "")
        );
        if (Option.isNone(row)) return invalid();
        if (row.value.status === "preparing") return unavailable();
        const selected = yield* waitFor(() => price(environment.DB, row.value.price_id));
        if (Option.isNone(selected)) return unavailable();
        const presented = yield* Schema.encodeEffect(Schema.toCodecJson(PaymentEnrollment))(
          project(row.value, selected.value, configured)
        );
        return json(presented);
      }
      return invalid();
    })
  ).catch(() => unavailable());
};
