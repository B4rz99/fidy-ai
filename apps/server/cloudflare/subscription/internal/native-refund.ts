import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Schema } from "effect";
import { type RefundStartFailure, StartRefundInput } from "../../../src/core/subscription/contract";
import { RefundRead, RefundSupportAdmission } from "../contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  Charge,
  RefundRow,
  liveRefundAuthority,
  prepareRefundTerms,
  replayView,
  safeFailure,
  view,
} from "./refund-acceptance";
import { refundFailureResponse, refundResultResponse } from "./refund-http-response";

const command = Schema.Union([RefundSupportAdmission, RefundRead]);

const fail = (reason: RefundStartFailure): Effect.Effect<never, RefundStartFailure> =>
  Effect.fail(reason);

const accepted = 202;

const observed = 200;

const refundRead = Effect.fn(function* (request: typeof RefundRead.Type) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT * FROM refund_attempt_context WHERE user_id=${request.userId} AND id=${request.refundAttemptId}`;

  if (row === undefined) return yield* fail("charge-unavailable");

  return yield* view(yield* Schema.decodeUnknownEffect(RefundRow)(row));
});

const selectCharge = Effect.fn(function* (input: typeof StartRefundInput.Encoded) {
  const sql = yield* SqliteClient;

  const rows =
    yield* sql`SELECT a.id,a.price_id,a.amount,a.currency,a.tax_treatment,a.wompi_environment,e.transaction_id,p.method
    FROM billing_attempt_context a JOIN billing_provider_transactions e ON e.attempt_id=a.id AND e.status='APPROVED'
    JOIN payment_source_context p ON p.id=a.payment_source_id AND p.user_id=a.user_id
    WHERE a.id=${input.billingAttemptId} AND a.user_id=${input.userId} AND a.status='succeeded' AND a.paid_starts_at_ms IS NOT NULL LIMIT 2`;

  const [row] = rows;

  if (rows.length !== 1 || row === undefined) return yield* fail("charge-unavailable");
  const charge = yield* Schema.decodeUnknownEffect(Charge)(row);

  if (
    charge.wompi_environment !== "sandbox" ||
    (input.intent.kind === "card-void" && charge.method !== "card")
  ) {
    return yield* fail("unsupported");
  }

  return charge;
});

const reserve = Effect.fn(function* (
  call: typeof RefundSupportAdmission.Type,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient;
  const { input, authority } = call;

  const intent = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toEncoded(StartRefundInput))
  )(input);

  const [previous] =
    yield* sql`SELECT * FROM refund_attempt_context WHERE user_id=${input.userId} AND request_id=${input.requestId}`;

  if (previous !== undefined) {
    return yield* replayView(yield* Schema.decodeUnknownEffect(RefundRow)(previous), intent);
  }

  const terms = yield* prepareRefundTerms(input, yield* selectCharge(input));

  if (!liveRefundAuthority({ authority, current: terms.now })) return yield* fail("unsupported");

  const rows =
    yield* sql`INSERT INTO refund_attempts(id,billing_attempt_id,wompi_environment,transaction_id,intent_json,treatment_json,amount_in_cents,operator_id,created_at_ms)
    VALUES(${terms.id},${terms.charge.id},'sandbox',${terms.charge.transaction_id},${intent},${terms.treatment},${terms.requested},${authority.operatorId},${terms.now}) RETURNING id`;

  if (rows.length === 0) {
    const [raw] =
      yield* sql`SELECT COALESCE(SUM(amount_in_cents),0) AS reserved FROM refund_attempts WHERE billing_attempt_id=${terms.charge.id} AND status<>'failed'`;

    const { reserved } = yield* Schema.decodeUnknownEffect(Schema.Struct({ reserved: Schema.Int }))(
      raw
    );

    return yield* fail(
      terms.requested > terms.total - reserved ? "amount-exceeds-remaining" : "limited"
    );
  }

  yield* preserveStoreAlarm(storage, terms.now);

  const [row] =
    yield* sql`SELECT * FROM refund_attempt_context WHERE id=${terms.id} AND user_id=${input.userId}`;

  return yield* view(yield* Schema.decodeUnknownEffect(RefundRow)(row));
});

export const handleLocalRefund = Effect.fn(
  function* (
    request: Request,
    {
      owns,
      storage,
      environment,
    }: {
      owns: (user: string) => boolean;
      storage: DurableObjectStorage;
      environment: string;
    }
  ) {
    const data = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(command))
    );

    const read = Schema.is(RefundRead)(data);
    const user = read ? data.userId : data.input.userId;

    const result = Effect.gen(function* () {
      if (
        !owns(user) ||
        environment !== "sandbox" ||
        !liveRefundAuthority({ authority: data.authority, current: yield* Clock.currentTimeMillis })
      ) {
        return yield* fail("unsupported");
      }

      const sql = yield* SqliteClient;

      if ((yield* sql`SELECT 1 FROM erasure_requests WHERE user_id=${user}`).length > 0) {
        return yield* fail("unsupported");
      }

      return read ? yield* refundRead(data) : yield* reserve(data, storage);
    }).pipe(withStoreCapacity(read ? "required" : "growth"), Effect.mapError(safeFailure));

    return yield* refundResultResponse({ result, status: read ? observed : accepted });
  },
  Effect.tapCause(Effect.logDebug),
  Effect.catchCause(() => Effect.succeed(refundFailureResponse("unavailable")))
);
