import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { Money } from "../../../src/core/_shared/money";
import {
  RefundAttempt,
  RefundStartFailure,
  StartRefundInput,
} from "../../../src/core/subscription/contract";
import { refundMinorUnits } from "../../../src/core/subscription/operations";
import { currentMillis } from "../../runtime/operations";
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
  snapshot_json: Schema.String,
  status: Schema.Literals(["pending", "succeeded", "failed"]),
  progress: Schema.Literals(["queued", "verifying", "outcome-unknown"]),
  finalized_at_ms: Schema.NullOr(Schema.Int),
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
const codec = Schema.fromJsonString(RefundAttempt);
const RowSnapshot = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const reject = (reason: RefundStartFailure): Effect.Effect<never, RefundStartFailure> =>
  Effect.fail(reason);
const safeFailure = (error: unknown): RefundStartFailure =>
  Schema.is(RefundStartFailure)(error) ? error : "unavailable";
export const liveRefundAuthority = (authority: RefundAuthority): boolean =>
  Schema.is(RefundSupportAdmission.fields.authority)(authority) &&
  authority.expiresAtMs > currentMillis();

const lifecycle = (row: typeof RefundRow.Type): Readonly<Record<string, unknown>> => {
  if (row.status === "pending") return { status: row.status, progress: row.progress };
  const finalized =
    row.finalized_at_ms === null
      ? undefined
      : DateTime.formatIso(DateTime.makeUnsafe(row.finalized_at_ms));
  if (row.status === "succeeded") return { status: row.status, verifiedAt: finalized };
  return { status: row.status, failedAt: finalized, failure: row.failure };
};
/** Decode a bounded, closed retained view without exposing any Wompi correlation facts. */
const view = (row: typeof RefundRow.Type): Effect.Effect<RefundAttempt, Schema.SchemaError> =>
  Effect.gen(function* () {
    const snapshot = yield* Schema.decodeEffect(RowSnapshot)(row.snapshot_json);
    return yield* Schema.decodeUnknownEffect(RefundAttempt)({ ...snapshot, ...lifecycle(row) });
  });
const readRow = (
  db: D1Database,
  userId: string,
  requestId: string
): Effect.Effect<Option.Option<typeof RefundRow.Type>, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db
      .prepare("SELECT * FROM refund_attempts WHERE user_id=? AND request_id=?")
      .bind(userId, requestId)
      .first()
  ).pipe(Effect.map(Schema.decodeUnknownOption(RefundRow)));
const replayView = (
  row: typeof RefundRow.Type,
  intent: string
): Effect.Effect<RefundAttempt, NativeRefundError> =>
  row.intent_json === intent ? view(row) : reject("idempotency-conflict");

export const getRefund = (call: RefundReadCall): Effect.Effect<RefundAttempt, RefundStartFailure> =>
  Effect.gen(function* () {
    if (!liveRefundAuthority(call.authority)) return yield* reject("unsupported");
    const row = yield* Effect.tryPromise(() =>
      call.db
        .prepare("SELECT * FROM refund_attempts WHERE user_id=? AND id=?")
        .bind(call.userId, call.refundAttemptId)
        .first()
    );
    const decoded = Schema.decodeUnknownOption(RefundRow)(row);
    if (Option.isNone(decoded)) return yield* reject("charge-unavailable");
    return yield* view(decoded.value);
  }).pipe(Effect.mapError(safeFailure));

const loadCharge = (call: RefundStartCall): Effect.Effect<typeof Charge.Type, NativeRefundError> =>
  Effect.gen(function* () {
    const charges = yield* Effect.tryPromise(() =>
      call.db
        .prepare(`SELECT a.id,a.price_id,a.amount,a.currency,
    a.tax_treatment,a.wompi_environment,e.transaction_id,p.method FROM billing_attempts a
    JOIN billing_transaction_evidence e ON e.attempt_id=a.id AND e.status='APPROVED'
    JOIN card_payment_sources p ON p.id=a.payment_source_id
    JOIN billing_paid_periods period ON period.attempt_id=a.id
    WHERE a.id=? AND a.user_id=? AND a.status='succeeded' LIMIT 2`)
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
  subscriptionId: string;
  now: number;
  snapshot: string;
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
    const now = currentMillis();
    const id = newId();
    const subscriptionId = newId();
    const snapshotValue = yield* Schema.decodeEffect(RefundAttempt)({
      id,
      subscriptionId,
      status: "pending",
      progress: "queued",
      userId: call.input.userId,
      billingAttemptId: charge.id,
      priceId: charge.price_id,
      kind: call.input.intent.kind,
      money: yield* Schema.encodeEffect(Money)(money),
      requestId: call.input.requestId,
      reason: call.input.reason,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      treatment: {
        policyId: "refund-ends-paid-period-v1",
        taxTreatment: charge.tax_treatment,
        paidPeriodEffect: "end-refunded-period-at-verification",
        renewalEffect: "stop-future-renewals",
        accounting: { kind: "sandbox-only" },
      },
    });
    const snapshot = yield* Schema.encodeEffect(codec)(snapshotValue);
    return {
      charge,
      requested: requested.value,
      total: total.value,
      id,
      subscriptionId,
      now,
      snapshot,
    };
  });
const reserve = (
  call: RefundStartCall,
  prepared: PreparedRefund,
  intent: string
): Effect.Effect<void, Cause.UnknownError> => {
  const { charge, id, subscriptionId, snapshot, requested, total, now } = prepared;
  return Effect.tryPromise(() =>
    call.db.batch([
      call.db
        .prepare(
          "INSERT INTO subscription_identities(user_id,id) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING"
        )
        .bind(call.input.userId, subscriptionId),
      call.db
        .prepare(`INSERT INTO refund_attempts (id,user_id,subscription_id,billing_attempt_id,transaction_id,
      request_id,intent_json,snapshot_json,amount_in_cents,original_cents,kind,operator_id,created_at_ms)
      SELECT ?,?,s.id,?,?,?,?,json_set(?, '$.subscriptionId',s.id),?,?,?,?,?
      FROM subscription_identities s WHERE s.user_id=? AND ? > ?
      ON CONFLICT(user_id,request_id) DO NOTHING`)
        .bind(
          id,
          call.input.userId,
          charge.id,
          charge.transaction_id,
          call.input.requestId,
          intent,
          snapshot,
          requested,
          total,
          call.input.intent.kind,
          call.authority.operatorId,
          now,
          call.input.userId,
          call.authority.expiresAtMs,
          now
        ),
    ])
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
    if (call.environment !== "sandbox" || !liveRefundAuthority(call.authority)) {
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
