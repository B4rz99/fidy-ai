import { type Cause, Clock, DateTime, Effect, Option, Schema } from "effect";
import { Money } from "../../../src/core/_shared/money";
import {
  CorrectionTreatment,
  RefundAttempt,
  RefundStartFailure,
  StartRefundInput,
} from "../../../src/core/subscription/contract";
import { refundMinorUnits } from "../../../src/core/subscription/operations";
import { newId } from "../../secret-material/operations";
import {
  type RefundAuthority,
  type RefundReadCall,
  type RefundStartCall,
  RefundSupportAdmission,
} from "../contract";

type NativeRefundError = RefundStartFailure | Schema.SchemaError | Cause.UnknownError;
const RefundRow = Schema.Struct({
  id: Schema.String,
  intent_json: Schema.String,
  user_id: Schema.String,
  subscription_id: Schema.String,
  billing_attempt_id: Schema.String,
  request_id: Schema.String,
  price_id: Schema.String,
  currency: Schema.Literal("COP"),
  amount_in_cents: Schema.Int,
  kind: Schema.Literals(["refund", "card-void"]),
  created_at_ms: Schema.DateTimeUtcFromMillis,
  treatment_json: Schema.String,
  status: Schema.Literals(["pending", "succeeded", "failed"]),
  progress: Schema.Literals(["queued", "verifying", "outcome-unknown"]),
  finalized_at_ms: Schema.NullOr(Schema.DateTimeUtcFromMillis),
  failure: Schema.NullOr(
    Schema.Literals(["provider-declined", "provider-cancelled", "provider-refused"])
  ),
});
const Charge = Schema.Struct({
  id: Schema.String,
  price_id: Schema.String,
  amount: Schema.String,
  currency: Schema.Literal("COP"),
  tax_treatment: Schema.Literal("not-taxable"),
  wompi_environment: Schema.String,
  transaction_id: Schema.String,
  method: Schema.Literals(["card", "nequi", "daviplata"]),
});
const treatmentCodec = Schema.fromJsonString(CorrectionTreatment);
type EncodedRefund = typeof RefundAttempt.Encoded;
type RefundLifecycle =
  | Pick<Extract<EncodedRefund, { status: "pending" }>, "status" | "progress">
  | Pick<Extract<EncodedRefund, { status: "succeeded" }>, "status" | "verifiedAt">
  | Pick<Extract<EncodedRefund, { status: "failed" }>, "status" | "failedAt" | "failure">;
const reject = (reason: RefundStartFailure): Effect.Effect<never, RefundStartFailure> =>
  Effect.fail(reason);
const safeFailure = (error: unknown): RefundStartFailure =>
  Schema.is(RefundStartFailure)(error) ? error : "unavailable";
const liveRefundAuthority = (authority: RefundAuthority, current: number): boolean =>
  Schema.is(RefundSupportAdmission.fields.authority)(authority) && authority.expiresAtMs > current;

const lifecycle = (
  row: typeof RefundRow.Type
): Effect.Effect<RefundLifecycle, RefundStartFailure> => {
  if (row.status === "pending") {
    return Effect.succeed({ status: row.status, progress: row.progress });
  }
  if (row.finalized_at_ms === null) return reject("unavailable");
  const finalized = DateTime.formatIso(row.finalized_at_ms);
  if (row.status === "succeeded") {
    return Effect.succeed({ status: row.status, verifiedAt: finalized });
  }
  if (row.failure === null) return reject("unavailable");
  return Effect.succeed({ status: row.status, failedAt: finalized, failure: row.failure });
};
/** Decode a bounded, closed retained view without exposing any Wompi correlation facts. */
const view = (
  row: typeof RefundRow.Type
): Effect.Effect<RefundAttempt, Schema.SchemaError | RefundStartFailure> =>
  Effect.gen(function* () {
    const intent = yield* Schema.decodeEffect(Schema.fromJsonString(StartRefundInput))(
      row.intent_json
    );
    const treatment = yield* Schema.decodeEffect(treatmentCodec)(row.treatment_json);
    const progress = yield* lifecycle(row);
    const cents = BigInt(row.amount_in_cents);
    const whole = cents / 100n;
    const fraction = String(cents % 100n).padStart(2, "0");
    return yield* Schema.decodeEffect(RefundAttempt)({
      id: row.id,
      userId: row.user_id,
      subscriptionId: row.subscription_id,
      billingAttemptId: row.billing_attempt_id,
      requestId: row.request_id,
      priceId: row.price_id,
      kind: row.kind,
      money: { amount: `${whole}.${fraction}`, currency: row.currency },
      reason: intent.reason,
      createdAt: DateTime.formatIso(row.created_at_ms),
      treatment: yield* Schema.encodeEffect(CorrectionTreatment)(treatment),
      ...progress,
    });
  });
const decodeRow = (
  row: unknown
): Effect.Effect<Option.Option<typeof RefundRow.Type>, Schema.SchemaError> =>
  row === null
    ? Effect.succeedNone
    : Schema.decodeUnknownEffect(RefundRow)(row).pipe(Effect.asSome);
const readRow = (
  db: D1Database,
  userId: string,
  requestId: string
): Effect.Effect<Option.Option<typeof RefundRow.Type>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.tryPromise(() =>
    db
      .prepare("SELECT * FROM refund_attempt_context r WHERE r.user_id=? AND r.request_id=?")
      .bind(userId, requestId)
      .first()
  ).pipe(Effect.flatMap(decodeRow));
const replayView = (
  row: typeof RefundRow.Type,
  intent: string
): Effect.Effect<RefundAttempt, NativeRefundError> =>
  row.intent_json === intent ? view(row) : reject("idempotency-conflict");

export const getRefund = (call: RefundReadCall): Effect.Effect<RefundAttempt, RefundStartFailure> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (!liveRefundAuthority(call.authority, current)) return yield* reject("unsupported");
    const row = yield* Effect.tryPromise(() =>
      call.db
        .prepare("SELECT * FROM refund_attempt_context r WHERE r.user_id=? AND r.id=?")
        .bind(call.userId, call.refundAttemptId)
        .first()
    );
    const decoded = yield* decodeRow(row);
    if (Option.isNone(decoded)) return yield* reject("charge-unavailable");
    return yield* view(decoded.value);
  }).pipe(Effect.mapError(safeFailure));

const loadCharge = (call: RefundStartCall): Effect.Effect<typeof Charge.Type, NativeRefundError> =>
  Effect.gen(function* () {
    const charges = yield* Effect.tryPromise(() =>
      call.db
        .prepare(`SELECT a.id,a.price_id,a.amount,a.currency,
    a.tax_treatment,a.wompi_environment,e.transaction_id,p.method FROM billing_attempt_context a
    JOIN billing_provider_transactions e ON e.attempt_id=a.id AND e.status='APPROVED'
    JOIN payment_source_context p ON p.id=a.payment_source_id
    WHERE a.id=? AND a.user_id=? AND a.status='succeeded' AND a.paid_starts_at_ms IS NOT NULL LIMIT 2`)
        .bind(call.input.billingAttemptId, call.input.userId)
        .all()
    );
    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Charge))(charges.results);
    const charge = decoded[0];
    if (decoded.length !== 1 || charge === undefined) return yield* reject("charge-unavailable");
    if (charge.wompi_environment !== "sandbox") return yield* reject("unsupported");
    if (call.input.intent.kind === "card-void" && charge.method !== "card") {
      return yield* reject("unsupported");
    }
    return charge;
  });

type PreparedRefund = Readonly<{
  charge: typeof Charge.Type;
  requested: number;
  total: number;
  id: string;
  now: number;
  treatment: string;
}>;
const prepareRefund = (call: RefundStartCall): Effect.Effect<PreparedRefund, NativeRefundError> =>
  Effect.gen(function* () {
    const charge = yield* loadCharge(call);
    const original = yield* Schema.decodeEffect(Money)({
      amount: charge.amount,
      currency: charge.currency,
    });
    const money =
      call.input.intent.kind === "refund"
        ? yield* Schema.decodeEffect(Money)(call.input.intent.money)
        : original;
    if (money.currency !== original.currency) return yield* reject("currency-mismatch");
    const total = refundMinorUnits(original);
    const requested = refundMinorUnits(money);
    if (Option.isNone(total) || Option.isNone(requested)) return yield* reject("unsupported");
    const now = yield* Clock.currentTimeMillis;
    const id = newId();
    const treatment = yield* Schema.encodeEffect(treatmentCodec)({
      policyId: "refund-ends-paid-period-v1",
      taxTreatment: charge.tax_treatment,
      paidPeriodEffect: "end-refunded-period-at-verification",
      renewalEffect: "stop-future-renewals",
      accounting: { kind: "sandbox-only" },
    });
    return {
      charge,
      requested: requested.value,
      total: total.value,
      id,
      now,
      treatment,
    };
  });
const reserve = (
  call: RefundStartCall,
  prepared: PreparedRefund,
  intent: string
): Effect.Effect<void, Cause.UnknownError> => {
  const { charge, id, treatment, requested, now } = prepared;
  return Effect.tryPromise(() =>
    call.db
      .prepare(`INSERT INTO refund_attempts (id,billing_attempt_id,wompi_environment,transaction_id,
      request_id,intent_json,treatment_json,amount_in_cents,kind,operator_id,created_at_ms)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ? > ?
      ON CONFLICT(user_id,request_id) DO NOTHING`)
      .bind(
        id,
        charge.id,
        charge.wompi_environment,
        charge.transaction_id,
        call.input.requestId,
        intent,
        treatment,
        requested,
        call.input.intent.kind,
        call.authority.operatorId,
        now,
        call.authority.expiresAtMs,
        now
      )
      .run()
  ).pipe(Effect.asVoid);
};
const reservationFailure = (
  db: D1Database,
  prepared: PreparedRefund
): Effect.Effect<never, NativeRefundError> =>
  Effect.gen(function* () {
    const reserved = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT COALESCE(SUM(amount_in_cents),0) AS amount
    FROM refund_attempts WHERE billing_attempt_id=? AND status<>'failed'`)
        .bind(prepared.charge.id)
        .first()
    );
    const amount = (yield* Schema.decodeUnknownEffect(Schema.Struct({ amount: Schema.Int }))(
      reserved
    )).amount;
    return yield* reject(
      prepared.requested > prepared.total - amount ? "amount-exceeds-remaining" : "limited"
    );
  });
/** Atomic acceptance owns the reservation and outbox; no provider calls occur in this transaction. */
export const startRefund = (
  call: RefundStartCall
): Effect.Effect<RefundAttempt, RefundStartFailure> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    if (call.environment !== "sandbox" || !liveRefundAuthority(call.authority, current)) {
      return yield* reject("unsupported");
    }
    const input = yield* Schema.decodeEffect(StartRefundInput)(call.input).pipe(
      Effect.mapError(() => "unsupported" as const)
    );
    const intent = yield* Schema.encodeEffect(Schema.fromJsonString(StartRefundInput))(input);
    const replay = yield* readRow(call.db, input.userId, input.requestId);
    if (Option.isSome(replay)) return yield* replayView(replay.value, intent);
    const prepared = yield* prepareRefund(call);
    yield* reserve(call, prepared, intent);
    const accepted = yield* readRow(call.db, input.userId, input.requestId);
    if (Option.isNone(accepted)) return yield* reservationFailure(call.db, prepared);
    return yield* replayView(accepted.value, intent);
  }).pipe(Effect.mapError(safeFailure));
