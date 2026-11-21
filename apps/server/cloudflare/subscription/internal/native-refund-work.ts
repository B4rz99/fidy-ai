import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Result, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { RefundAttemptId } from "../../../src/core/subscription/contract";
import { LocalRefundWork, RefundWorkFailure } from "../contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { RefundSubmissionSnapshot, submission } from "./refund-workflow";
import { submitCorrection, verifyCardVoid } from "./wompi-refund-client";
import type { WompiTransportFactory } from "./wompi-runtime";
import type { WompiBindings } from "../contract";

const maximumChecks = 8;

const pageSize = 32;

const Due = Schema.Struct({ user_id: UserId, id: RefundAttemptId, verification: Schema.Int });

const eligibility =
  "intent_json IS NOT NULL AND status='pending' AND (submission_claimed_at_ms IS NULL OR (kind='card-void' AND verification_attempts<8))";

const due =
  "max(coalesce(dispatch_last_attempt_at_ms,created_at_ms-60000),coalesce(last_verification_at_ms,created_at_ms-60000))+60000";

export const refundWake = Effect.fnUntraced(function* (storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const [raw] = yield* sql.unsafe(
    "SELECT min(" + due + ") AS deadline FROM refund_attempts WHERE " + eligibility
  );

  const { deadline } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ deadline: Schema.OptionFromNullOr(Schema.Int) })
  )(raw);

  if (Option.isSome(deadline)) yield* preserveStoreAlarm(storage, deadline.value);

  return Option.isSome(deadline);
});

export const offerRefunds = Effect.fnUntraced(function* ({
  storage,
  queue,
  current,
}: {
  storage: DurableObjectStorage;
  queue: { send: (work: typeof LocalRefundWork.Type) => Promise<QueueSendResponse | void> };
  current: number;
}) {
  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqliteClient;

    const raw = yield* sql.unsafe(
      "UPDATE refund_attempts SET dispatch_last_attempt_at_ms=? WHERE id IN (SELECT id FROM refund_attempts WHERE " +
        eligibility +
        " AND " +
        due +
        "<=? ORDER BY created_at_ms,id LIMIT ?) RETURNING user_id,id,CASE WHEN submission_claimed_at_ms IS NULL THEN 0 ELSE verification_attempts+1 END AS verification",
      [current, current, pageSize]
    );

    yield* refundWake(storage);

    return yield* Schema.decodeUnknownEffect(Schema.Array(Due))(raw);
  }).pipe(withStoreCapacity("required"));

  let failed = 0;

  yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (row) {
      const sent = yield* Effect.result(
        Effect.tryPromise(() =>
          queue.send(
            LocalRefundWork.make({
              userId: row.user_id,
              refundAttemptId: row.id,
              verification: row.verification,
            })
          )
        )
      );

      if (Result.isFailure(sent)) failed++;
    }),
    { discard: true }
  );

  return { attempted: rows.length, failed };
});

const claim = Effect.fnUntraced(function* (
  work: typeof LocalRefundWork.Type,
  storage: DurableObjectStorage
) {
  const sql = yield* SqliteClient,
    now = yield* Clock.currentTimeMillis;

  const [held] =
    yield* sql`SELECT r.id,r.kind,r.transaction_id,r.amount_in_cents,r.original_cents,a.wompi_reference,s.wompi_source_id FROM refund_attempt_context r JOIN billing_attempt_context a ON a.id=r.billing_attempt_id JOIN payment_source_context s ON s.id=a.payment_source_id AND s.user_id=a.user_id WHERE r.user_id=${work.userId} AND r.id=${work.refundAttemptId} AND r.status='pending' AND a.status='succeeded' AND a.wompi_environment='sandbox'
  AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=r.user_id) AND (SELECT count(*) FROM billing_provider_transactions WHERE attempt_id=a.id AND status='APPROVED')=1`;

  if (held === undefined) return Option.none();
  const data = submission(yield* Schema.decodeUnknownEffect(RefundSubmissionSnapshot)(held));

  const claimed =
    work.verification === 0
      ? yield* sql`UPDATE refund_attempts SET submission_claimed_at_ms=${now},progress='verifying' WHERE id=${data.id} AND status='pending' AND submission_claimed_at_ms IS NULL RETURNING id`
      : yield* sql`UPDATE refund_attempts SET verification_attempts=${work.verification},last_verification_at_ms=${now} WHERE id=${data.id} AND status='pending' AND kind='card-void' AND submission_claimed_at_ms IS NOT NULL AND verification_attempts=${work.verification - 1} AND ${work.verification}<=${maximumChecks} RETURNING id`;

  if (claimed.length !== 1) return Option.none();
  yield* refundWake(storage);

  return Option.some(data);
});

export const runOwnerRefund = Effect.fnUntraced(function* (
  work: typeof LocalRefundWork.Type,
  context: {
    storage: DurableObjectStorage;
    owns: (user: string) => boolean;
    env: WompiBindings;
    transport: WompiTransportFactory;
  }
) {
  if (
    !context.owns(work.userId) ||
    context.env.WOMPI_ENVIRONMENT !== "sandbox" ||
    !context.env.WOMPI_PRIVATE_KEY.startsWith("prv_test_")
  ) {
    return;
  }

  const held = yield* claim(work, context.storage).pipe(withStoreCapacity("required"));

  if (Option.isNone(held)) return;
  const http = yield* context.transport(context.env);
  const args = { http, input: held.value };

  const evidence =
    work.verification === 0 ? yield* submitCorrection(args) : yield* verifyCardVoid(args);

  yield* Effect.gen(function* () {
    const sql = yield* SqliteClient,
      now = yield* Clock.currentTimeMillis;

    if (Option.isNone(evidence)) {
      yield* sql`UPDATE refund_attempts SET progress='outcome-unknown' WHERE id=${work.refundAttemptId} AND status='pending' AND submission_claimed_at_ms IS NOT NULL`;
    } else {
      yield* sql`UPDATE refund_attempts SET provider_refund_id=${evidence.value.providerId},verified_status=${evidence.value.status},observed_at_ms=${now} WHERE id=${work.refundAttemptId} AND user_id=${work.userId} AND status='pending' AND verified_status IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=${work.userId})`;
    }

    yield* refundWake(context.storage);
  }).pipe(withStoreCapacity("required"));
});

export const runRefundStep = Effect.fnUntraced(function* (
  payload: unknown,
  users: Pick<DurableObjectNamespace, "getByName">
) {
  const work = yield* Schema.decodeUnknownEffect(LocalRefundWork)(payload);
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(LocalRefundWork))(work);

  const reply = yield* Effect.tryPromise((signal) =>
    users
      .getByName(work.userId)
      .fetch("https://user.invalid/work/refund", { method: "POST", body, signal })
  );

  if (!reply.ok) return yield* new RefundWorkFailure({ reason: "unavailable" });
});
