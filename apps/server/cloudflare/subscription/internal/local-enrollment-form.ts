import { textReport } from "./local-billing-admission";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  PaymentEnrollmentId,
  PreparedPaymentEnrollment,
  RecurringDisclosure,
  SubscriptionOffers,
} from "../../../src/core/subscription/contract";
import { PreparePaymentEnrollmentPayload } from "../../../src/shell/subscription/contract";
import { digestBytes, newId } from "../../secret-material/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { pricingName } from "../contract";
import {
  daviplataPolicy,
  enrollmentDisclosureRevisions,
  readEnrollmentBody,
} from "./enrollment-policy";
import {
  type BrowserEnrollment,
  type EnrollmentSession,
  type NativeEnrollmentEnv,
  invalidEnrollment,
  json,
  limitedEnrollment,
  liveSession,
  unauthorizedEnrollment,
  unavailableEnrollment,
} from "./enrollment-session";
import { WompiEnrollmentClient } from "./wompi-client";
import { type WompiTransportFactory, workerDigest } from "./wompi-runtime";

const isResponse = Schema.is(Schema.instanceOf(Response));

export const formCodec = Schema.fromJsonString(Schema.toCodecJson(PreparedPaymentEnrollment));

export const enrollmentWompi = Effect.fn(function* (
  env: NativeEnrollmentEnv,
  transport: WompiTransportFactory
) {
  return WompiEnrollmentClient.fromOutboundHttp({
    publicKey: env.WOMPI_PUBLIC_KEY,
    digest: workerDigest,
    outboundHttp: yield* transport(env),
  });
});

const allowanceFailure = (status: number): Response =>
  status === rateLimitedStatus ? limitedEnrollment() : unavailableEnrollment();

const rateLimitedStatus = 429;

const hour = 3600000;

const enrollmentLifetime = 900000;

const maximumPreparations = 12;

export const enrollmentAllowance = Effect.fn(function* (env: NativeEnrollmentEnv, userId: string) {
  const body = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.Struct({ userId: Schema.String }))
  )({ userId });

  return yield* Effect.tryPromise(() =>
    env.PRICING.getByName(pricingName).fetch("https://pricing.internal/allow-enrollment", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );
});

type Preparation = typeof PreparePaymentEnrollmentPayload.Type;

type Reservation = {
  env: NativeEnrollmentEnv;
  session: EnrollmentSession;
  body: Preparation;
  enrollmentId: PaymentEnrollmentId;
  now: number;
  deadline: number;
};

type OpenFormRow = Readonly<{
  state: unknown;
  price_id: unknown;
  method: unknown;
  environment: unknown;
}>;

const matchesOpenForm = (
  prior: OpenFormRow,
  body: Preparation,
  env: NativeEnrollmentEnv
): boolean => {
  const { priceId, method, replaceFailedSource } = body;

  return (
    prior.state === "prepared" &&
    prior.price_id === priceId &&
    prior.method === method &&
    replaceFailedSource !== true &&
    prior.environment === env.WOMPI_ENVIRONMENT
  );
};

const previousForm = Effect.fn(function* (input: Reservation) {
  const sql = yield* SqliteClient;
  const { session, env, now, body } = input;
  yield* sql`UPDATE payment_enrollments SET state='expired' WHERE user_id=${session.user_id} AND state IN ('preparing','prepared') AND deadline_ms<=${now}`;

  const [prior] =
    yield* sql`SELECT * FROM payment_enrollments WHERE user_id=${session.user_id} AND state IN('preparing','prepared','creating','verifying')`;

  if (prior !== undefined) {
    if (
      matchesOpenForm(
        {
          state: prior.state,
          price_id: prior.price_id,
          method: prior.method,
          environment: prior.environment,
        },
        body,
        env
      )
    ) {
      return textReport(String(prior.form));
    }

    if (prior.state === "creating" || prior.state === "verifying") {
      return json({
        body: {
          status: prior.state,
          enrollmentId: prior.id,
          method: prior.method,
          priceId: prior.price_id,
        },
        status: 200,
      });
    }

    if (
      prior.state !== "prepared" ||
      (yield* sql`SELECT 1 FROM billing_admissions WHERE subject_id=${prior.id} AND outcome IS NULL`)
        .length > 0
    ) {
      return unavailableEnrollment();
    }

    yield* sql`UPDATE payment_enrollments SET state='expired' WHERE id=${prior.id}`;
  }

  return undefined;
});

const retireFailedCard = Effect.fn(function* (id: string, user: string, now: number) {
  const sql = yield* SqliteClient;

  const [failed] =
    yield* sql`SELECT 1 FROM billing_attempts WHERE payment_source_id=${id} AND NOT EXISTS(SELECT 1 FROM subscription_standing WHERE user_id=${user}) AND NOT EXISTS(SELECT 1 FROM billing_attempts a WHERE a.payment_source_id=${id} AND (a.status<>'failed' OR EXISTS(SELECT 1 FROM billing_provider_transactions e WHERE e.attempt_id=a.id AND e.status IN('APPROVED','PENDING')) OR (a.no_charge_confirmed_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM billing_retry_clearances c WHERE c.attempt_id=a.id))))`;

  if (failed === undefined) return false;
  yield* sql`UPDATE payment_sources SET retired_at_ms=${now} WHERE id=${id}`;

  return true;
});

const selectPaymentSource = Effect.fn(function* (input: Reservation) {
  const {
    session,
    env,
    now,
    body: { replaceFailedSource, method },
  } = input;

  const sql = yield* SqliteClient;

  const [source] =
    yield* sql`SELECT s.*,EXISTS(SELECT 1 FROM subscription_cancellations c WHERE c.payment_source_id=s.id) AS cancelled FROM payment_source_context s WHERE user_id=${session.user_id} AND retired_at_ms IS NULL`;

  const fresh = {
    id: null,
    billingEmail: Option.getOrElse(Option.fromNullOr(session.email), () => ""),
    paymentSourceMode: "create" as const,
  };

  if (source === undefined) return fresh;

  if (source.cancelled === 1 || source.wompi_environment !== env.WOMPI_ENVIRONMENT) {
    return invalidEnrollment();
  }

  if (replaceFailedSource === true && source.method === "card") {
    return (yield* retireFailedCard(String(source.id), session.user_id, now))
      ? fresh
      : invalidEnrollment();
  }

  return source.method === method
    ? {
        id: String(source.id),
        billingEmail: String(source.billing_email),
        paymentSourceMode: "reuse" as const,
      }
    : invalidEnrollment();
});

const reserveForm = Effect.fn(function* (input: Reservation) {
  const sql = yield* SqliteClient;

  const {
    env,
    session,
    body: { priceId, method },
    enrollmentId,
    now,
    deadline,
  } = input;

  if (!(yield* liveSession(session))) return unauthorizedEnrollment();
  const prior = yield* previousForm(input);

  if (prior !== undefined) return prior;

  const [capacity] =
    yield* sql`SELECT count(*) AS n FROM payment_enrollments WHERE user_id=${session.user_id} AND prepared_at_ms>${now - hour}`;

  if (Number(capacity?.n) >= maximumPreparations) return limitedEnrollment();
  const payment = yield* selectPaymentSource(input);

  if (isResponse(payment)) return payment;
  yield* sql`INSERT INTO payment_enrollments(id,user_id,environment,method,price_id,prepared_at_ms,deadline_ms,state,source_id,email) VALUES (${enrollmentId},${session.user_id},${env.WOMPI_ENVIRONMENT},${method},${priceId},${now},${deadline},'preparing',${payment.id},${payment.billingEmail})`;

  return { billingEmail: payment.billingEmail, paymentSourceMode: payment.paymentSourceMode };
});

export const prepareLocalForm = Effect.fn(function* (input: BrowserEnrollment) {
  const { request, env, session } = input;

  const body = yield* readEnrollmentBody({ request, schema: PreparePaymentEnrollmentPayload });

  if (Option.isNone(body)) return invalidEnrollment();
  const { method, priceId } = body.value;
  const wallet = daviplataPolicy(env);

  if (method === "daviplata" && Option.isNone(wallet)) {
    return unavailableEnrollment();
  }

  const offers = yield* Effect.tryPromise(() =>
    env.PRICING.getByName(pricingName)
      .fetch("https://pricing.internal/offers")
      .then((res) => res.json())
  );

  const selected = (yield* Schema.decodeUnknownEffect(SubscriptionOffers)(offers)).find(
    (price) => price.id === priceId
  );

  if (selected === undefined) return invalidEnrollment();
  const enrollmentId = PaymentEnrollmentId.make(newId());
  const now = yield* Clock.currentTimeMillis;
  const deadline = now + enrollmentLifetime;
  const allowance = yield* enrollmentAllowance(env, session.user_id);

  if (!allowance.ok) {
    return allowanceFailure(allowance.status);
  }

  const reserved = yield* reserveForm({
    env,
    session,
    body: body.value,
    enrollmentId,
    now,
    deadline,
  }).pipe(withStoreCapacity("growth"));

  if (isResponse(reserved)) return reserved;

  const form = yield* presentPrepared({
    input,
    reserved,
    selected,
    enrollmentId,
    now,
    deadline,
    method,
  });

  if (isResponse(form)) return form;

  return yield* saveForm(enrollmentId, form);
});

const saveForm = Effect.fn(function* (
  enrollmentId: PaymentEnrollmentId,
  form: typeof PreparedPaymentEnrollment.Type
) {
  const sql = yield* SqliteClient;
  const encoded = yield* Schema.encodeEffect(formCodec)(form);

  const rows =
    yield* sql`UPDATE payment_enrollments SET form=${encoded},state='prepared' WHERE id=${enrollmentId} AND state='preparing' RETURNING id`;

  return rows.length === 1
    ? new Response(encoded, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      })
    : unavailableEnrollment();
});

const presentPrepared = Effect.fn(function* ({
  input,
  reserved,
  selected,
  enrollmentId,
  now,
  deadline,
  method,
}: {
  input: BrowserEnrollment;
  reserved: { billingEmail: string; paymentSourceMode: "create" | "reuse" };
  selected: SubscriptionOffers[number];
  enrollmentId: PaymentEnrollmentId;
  now: number;
  deadline: number;
  method: Preparation["method"];
}) {
  const { env, transport } = input;
  const sql = yield* SqliteClient;
  const wallet = daviplataPolicy(env);
  const client = yield* enrollmentWompi(env, transport);
  const contracts = yield* Effect.result(client.contracts(DateTime.makeUnsafe(now)));

  if (Result.isFailure(contracts)) {
    yield* sql`UPDATE payment_enrollments SET state='refused',reason='provider-error' WHERE id=${enrollmentId} AND state='preparing'`;

    return unavailableEnrollment();
  }

  const displayedText =
    method === "card"
      ? "Autorizo los cobros recurrentes de mi suscripción. Si cambia el precio, Fidy me informará de inmediato y los próximos cobros usarán el nuevo precio sin una nueva aceptación. Los cobros pendientes conservan su precio."
      : "Autorizo los cobros recurrentes de mi suscripción.";

  const recurringDisclosure = RecurringDisclosure.make({
    revision: enrollmentDisclosureRevisions[method],
    displayedText,
    contentSha256: Hex.encode(yield* digestBytes(new TextEncoder().encode(displayedText))),
  });

  const form = yield* Schema.decodeUnknownEffect(Schema.toType(PreparedPaymentEnrollment))({
    status: "prepared",
    enrollmentId,
    price: selected,
    ...reserved,
    method,
    contracts: contracts.success.evidence,
    recurringDisclosure,
    wompiPublicKey: env.WOMPI_PUBLIC_KEY,
    expiresAt: DateTime.makeUnsafe(deadline),
    ...Option.match(
      Option.filter(wallet, () => method === "daviplata"),
      { onNone: () => ({}), onSome: (daviplataOtpPolicy) => ({ daviplataOtpPolicy }) }
    ),
  });

  return form;
});
