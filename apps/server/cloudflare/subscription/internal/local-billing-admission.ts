import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Predicate, Schema } from "effect";
import { Hex } from "effect/encoding";
import { BillingAttempt, Price } from "../../../src/core/subscription/contract";
import { type UserId } from "../../../src/core/identity/contract";
import { type IanaTimeZone } from "../../../src/core/_shared/context";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { digestBytes, newId } from "../../secret-material/operations";
import { BillingRegistration, pricingName } from "../contract";
import { type EnrollmentSession, json } from "./enrollment-session";
import { admitLocalRequest } from "../../canonical-admission/operations";

export type Registration = typeof BillingRegistration.Type;

export const requestCodec = Schema.fromJsonString(BillingRegistration);

export const priceCodec = Schema.fromJsonString(Price);

const conflictStatus = 409;

const expiredStatus = 410;

const termsResponse = Schema.Struct({ ...BillingRegistration.fields, price: Price });

export const hashInputs = Effect.fn(function* (text: string) {
  return Hex.encode(yield* digestBytes(new TextEncoder().encode(text)));
});

export const saveRegistration = Effect.fn(function* (
  reg: Registration,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;
  const request = yield* Schema.encodeEffect(requestCodec)(reg);

  const subject =
    reg.admission.kind === "renewal"
      ? reg.admission.previousPaidAttemptId
      : reg.admission.enrollmentId;

  yield* sql`INSERT INTO billing_admissions(operation_id,user_id,subject_id,request) VALUES(${reg.operationId},${reg.userId},${subject},${request}) ON CONFLICT DO NOTHING`;
  yield* preserveStoreAlarm(storage, reg.deadlineMs);

  const [same] =
    yield* sql`SELECT request,outcome,report FROM billing_admissions WHERE operation_id=${reg.operationId} AND user_id=${reg.userId} AND request=${request}`;

  return same;
});

export const registerTerms = Effect.fn(function* (
  pricing: DurableObjectNamespace,
  reg: Registration
) {
  const body = yield* Schema.encodeEffect(requestCodec)(reg);

  const response = yield* Effect.tryPromise(() =>
    pricing.getByName(pricingName).fetch("https://pricing.internal/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
  );

  if (response.status === conflictStatus || response.status === expiredStatus) {
    return Option.none<Price>();
  }

  if (!response.ok) return yield* Effect.fail("pricing-unavailable" as const);

  const receipt = yield* Schema.decodeUnknownEffect(termsResponse)(
    yield* Effect.tryPromise(() => response.json())
  );

  if (!Schema.toEquivalence(BillingRegistration)(reg, receipt)) {
    return yield* Effect.fail("registration-mismatch" as const);
  }

  return Option.some(receipt.price);
});

export const reportForAttempt = Effect.fn(function* (user: UserId, attemptId: string) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT * FROM billing_attempt_context WHERE user_id=${user} AND id=${attemptId}`;

  if (!Predicate.isString(row?.price_terms)) return Option.none<BillingAttempt>();
  const price = yield* Schema.decodeEffect(priceCodec)(row.price_terms);

  const data = {
    id: row.id,
    priceId: price.id,
    money: price.money,
    billingPeriod: price.billingPeriod,
    serviceMarket: price.serviceMarket,
    taxTreatment: price.taxTreatment,
    timeZone: row.time_zone,
    createdAt: DateTime.makeUnsafe(Number(row.created_at_ms)),
    status: row.status,
  };

  const outcome: Record<string, DateTime.Utc> = {};

  if (row.status === "failed") outcome.failedAt = DateTime.makeUnsafe(Number(row.finalized_at_ms));

  if (row.status === "succeeded") {
    outcome.finalizedAt = DateTime.makeUnsafe(Number(row.finalized_at_ms));
    outcome.paidPeriodEndsAt = DateTime.makeUnsafe(Number(row.paid_ends_at_ms));
    outcome.renewalAnchor = DateTime.makeUnsafe(Number(row.paid_renewal_anchor_ms));
  }

  return Option.some(
    yield* Schema.decodeUnknownEffect(Schema.toType(BillingAttempt))({ ...data, ...outcome })
  );
});

export const textReport = (text: string): Response =>
  new Response(text, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

type Period = { previous: string; starts: number; ends: number; anchor: number; number: number };

export const insertAttempt = Effect.fn(function* (input: {
  user: UserId;
  id: string;
  price: Price;
  source: string;
  zone: IanaTimeZone;
  environment: string;
  now: number;
  period: Option.Option<Period>;
  storage: DurableObjectStorage;
}) {
  const sql = yield* SqliteClient;
  const terms = yield* Schema.encodeEffect(priceCodec)(input.price);

  const period = Option.getOrElse(input.period, () => ({
    previous: null,
    starts: null,
    ends: null,
    anchor: null,
    number: null,
  }));

  yield* sql`INSERT INTO billing_attempts(id,subscription_id,payment_source_id,wompi_reference,amount,currency,billing_period,time_zone,wompi_environment,created_at_ms,collection_state,price_terms,next_offer_ms,previous_paid_attempt_id,period_starts_at_ms,period_ends_at_ms,calendar_anchor_ms,renewal_attempt_number)
    SELECT ${input.id},s.subscription_id,s.id,${"fidy-" + input.id},${(yield* Schema.encodeEffect(Price)(input.price)).money.amount},${input.price.money.currency},${input.price.billingPeriod},${input.zone},${input.environment},${input.now},'armed',${terms},${input.now},${period.previous},${period.starts},${period.ends},${period.anchor},${period.number}
    FROM payment_source_context s WHERE s.user_id=${input.user} AND s.id=${input.source} AND retired_at_ms IS NULL AND wompi_environment=${input.environment}`;
  const attempt = yield* reportForAttempt(input.user, input.id);

  if (Option.isNone(attempt)) return yield* Effect.fail("attempt-not-inserted" as const);

  const audit =
    yield* sql`INSERT INTO billing_transition_audit VALUES(${input.id},'admitted',${input.now}) RETURNING attempt_id`;

  if (audit.length !== 1) return yield* Effect.fail("billing-audit-unavailable" as const);
  yield* preserveStoreAlarm(input.storage, input.now);

  return attempt.value;
});

export const finishAdmission = Effect.fn(function* ({
  reg,
  price,
  report,
  now,
  session,
}: {
  reg: Registration;
  price: Price;
  report: string;
  now: number;
  session: Option.Option<EnrollmentSession>;
}) {
  const sql = yield* SqliteClient;

  if (Option.isSome(session)) {
    if ((yield* admitLocalRequest({ user: session.value.user_id, current: now })).length !== 1) {
      return yield* Effect.fail("admission-limited" as const);
    }

    const audit =
      yield* sql`INSERT INTO audit_entries(id,user_id,session_id,record_type,operation,outcome,occurred_at_ms) VALUES(${newId()},${reg.userId},${session.value.id},'session_call','subscription.submitPaymentEnrollment','success',${now}) RETURNING id`;

    if (audit.length !== 1) return yield* Effect.fail("billing-audit-unavailable" as const);
  }

  const terms = yield* Schema.encodeEffect(priceCodec)(price);
  const request = yield* Schema.encodeEffect(requestCodec)(reg);

  const changed =
    yield* sql`UPDATE billing_admissions SET terms=${terms},outcome='committed',report=${report},ack_due_ms=${now} WHERE operation_id=${reg.operationId} AND request=${request} AND outcome IS NULL RETURNING 1`;

  if (changed.length !== 1) return yield* Effect.fail("admission-fenced" as const);
});

export const cancelRegistration = Effect.fn(function* (
  reg: Registration,
  owns: (id: string) => boolean,
  cancel: boolean = false
) {
  if (!owns(reg.userId)) return new Response(null, { status: 404 });
  const sql = yield* SqliteClient;

  return yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const request = yield* Schema.encodeEffect(requestCodec)(reg);

      const [row] =
        yield* sql`SELECT outcome FROM billing_admissions WHERE operation_id=${reg.operationId} AND user_id=${reg.userId} AND request=${request}`;

      if (row === undefined) return new Response(null, { status: 409 });

      if (row.outcome === null) {
        const now = yield* Clock.currentTimeMillis;

        if (!cancel && now < reg.deadlineMs) return new Response(null, { status: 409 });

        const fenced =
          yield* sql`UPDATE billing_admissions SET outcome='cancelled',ack_due_ms=${now} WHERE operation_id=${reg.operationId} AND outcome IS NULL RETURNING operation_id`;

        if (fenced.length !== 1) return yield* Effect.fail("billing-fence-unavailable" as const);

        if (reg.admission.kind === "enrollment") {
          yield* sql`UPDATE payment_enrollments SET state='expired',next_lookup_ms=NULL WHERE id=${reg.admission.enrollmentId} AND (state IN('preparing','prepared') OR NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${reg.userId})) AND state<>'available'`;
        }
      }

      return json({ body: { request: reg, outcome: row.outcome ?? "cancelled" }, status: 200 });
    })
  );
});
