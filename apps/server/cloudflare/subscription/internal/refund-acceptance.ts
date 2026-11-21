import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { Money } from "../../../src/core/_shared/money";
import {
  CorrectionTreatment,
  RefundAttempt,
  RefundStartFailure,
  StartRefundInput,
} from "../../../src/core/subscription/contract";
import { refundMinorUnits } from "../../../src/core/subscription/operations";
import { newId } from "../../secret-material/operations";
import { type RefundAuthority, RefundSupportAdmission } from "../contract";

export const RefundRow = Schema.Struct({
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

export const Charge = Schema.Struct({
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

export const safeFailure = (error: unknown): RefundStartFailure =>
  Schema.is(RefundStartFailure)(error) ? error : "unavailable";

export const liveRefundAuthority = ({
  authority,
  current,
}: {
  authority: RefundAuthority;
  current: number;
}): boolean =>
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

export const view = (
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

export const replayView = Effect.fnUntraced(function* (row: typeof RefundRow.Type, intent: string) {
  return row.intent_json === intent ? yield* view(row) : yield* reject("idempotency-conflict");
});

export const prepareRefundTerms = Effect.fnUntraced(function* (
  input: typeof StartRefundInput.Encoded,
  charge: typeof Charge.Type
) {
  const original = yield* Schema.decodeEffect(Money)({
    amount: charge.amount,
    currency: charge.currency,
  });

  const money =
    input.intent.kind === "refund"
      ? yield* Schema.decodeEffect(Money)(input.intent.money)
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
