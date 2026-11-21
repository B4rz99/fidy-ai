import { reconcileLocalCandidates } from "./native-billing";
import { processRenewal } from "./local-renewal";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Result, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { BillingAttemptId } from "../../../src/core/subscription/contract";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { BillingRegistration, LocalBillingCollection, pricingName } from "../contract";
import type { EnrollmentContext, NativeEnrollmentEnv } from "./enrollment-session";
import { recoverCandidate } from "./local-enrollment-submit";
import { cancelRegistration, requestCodec } from "./local-billing-admission";

const cooldown = 60000;

const pageSize = 16;

type Environment = NativeEnrollmentEnv & {
  BILLING_COLLECTION_QUEUE: {
    send: (body: typeof LocalBillingCollection.Type) => Promise<unknown>;
  };
};

export const billingWake = Effect.fn(function* (storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const [row] = yield* sql`SELECT
    (SELECT min(next_offer_ms) FROM billing_attempts WHERE collection_state='armed' AND NOT EXISTS(SELECT 1 FROM erasure_requests)) AS collection,
    (SELECT min(ack_due_ms) FROM billing_admissions) AS acknowledge,
    (SELECT min(json_extract(request,'$.deadlineMs')) FROM billing_admissions WHERE outcome IS NULL) AS deadline,
    (SELECT min(next_lookup_ms) FROM payment_enrollments WHERE state IN('prepared','verifying')) AS source,
    (SELECT min(followup_due_at_ms) FROM billing_attempts WHERE NOT EXISTS(SELECT 1 FROM erasure_requests)) AS renewal,
    (SELECT min(next_check_ms) FROM billing_provider_transactions WHERE NOT EXISTS(SELECT 1 FROM erasure_requests WHERE state<>'Draining')) AS verify`;

  const deadlines = Object.values(row ?? {}).filter(
    (value): value is number => typeof value === "number"
  );

  return deadlines.length > 0 ? yield* preserveStoreAlarm(storage, Math.min(...deadlines)) : false;
});

export const answerRegistration = Effect.fn(function* (
  request: Request,
  owns: (id: string) => boolean
) {
  return yield* cancelRegistration(
    yield* Schema.decodeUnknownEffect(BillingRegistration)(
      yield* Effect.tryPromise(() => request.json())
    ),
    owns,
    new URL(request.url).pathname === "/billing/registration-cancel"
  );
});

export type BillingRecovery = EnrollmentContext & {
  env: Environment;
  owns: (id: string) => boolean;
};

export const recoverLocalBilling = Effect.fn(function* (context: BillingRecovery) {
  const { env, storage, owns, transport } = context;
  const sql = yield* SqliteClient;
  const now = yield* Clock.currentTimeMillis;
  yield* reconcileLocalCandidates({ env, storage, owns, transport });

  const renewals =
    yield* sql`SELECT id FROM billing_attempts WHERE NOT EXISTS(SELECT 1 FROM erasure_requests) AND followup_due_at_ms<=${now} ORDER BY followup_due_at_ms LIMIT ${pageSize}`;

  yield* Effect.forEach(
    renewals,
    Effect.fnUntraced(function* (row) {
      yield* processRenewal(String(row.id), context);
    }),
    { discard: true }
  );

  const send = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const rows =
        yield* sql`UPDATE billing_attempts SET next_offer_ms=${now + cooldown} WHERE id IN(SELECT id FROM billing_attempts WHERE collection_state='armed' AND NOT EXISTS(SELECT 1 FROM erasure_requests) AND next_offer_ms<=${now} ORDER BY next_offer_ms LIMIT ${pageSize}) RETURNING id,(SELECT user_id FROM subscriptions WHERE id=billing_attempts.subscription_id) AS user_id`;

      yield* billingWake(storage);

      return yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ id: BillingAttemptId, user_id: UserId }))
      )(rows);
    })
  );

  const offered = yield* Effect.forEach(
    send,
    (row) =>
      Effect.tryPromise(() =>
        env.BILLING_COLLECTION_QUEUE.send(
          LocalBillingCollection.make({ userId: row.user_id, attemptId: row.id })
        )
      ).pipe(Effect.timeout("5 seconds"), Effect.result),
    { concurrency: 4 }
  );

  const expired =
    yield* sql`SELECT request FROM billing_admissions WHERE outcome IS NULL AND json_extract(request,'$.deadlineMs')<=${now} LIMIT ${pageSize}`;

  yield* Effect.forEach(
    expired,
    Effect.fnUntraced(function* (row) {
      yield* cancelRegistration(yield* Schema.decodeUnknownEffect(requestCodec)(row.request), owns);
    }),
    { discard: true }
  );

  const due =
    yield* sql`SELECT id FROM payment_enrollments WHERE state IN('prepared','verifying') AND next_lookup_ms<=${now} LIMIT ${pageSize}`;

  yield* Effect.forEach(
    due,
    Effect.fnUntraced(function* (row) {
      yield* recoverCandidate(context, String(row.id));
    }),
    { discard: true }
  );
  yield* acknowledgeOutcomes(env, now);
  yield* billingWake(storage);

  return { attempted: send.length, failed: offered.filter(Result.isFailure).length };
});

const acknowledgeOutcomes = Effect.fn(function* (env: Environment, now: number) {
  const sql = yield* SqliteClient;

  const ack =
    yield* sql`UPDATE billing_admissions SET ack_due_ms=${now + cooldown} WHERE operation_id IN(SELECT operation_id FROM billing_admissions WHERE ack_due_ms<=${now} ORDER BY ack_due_ms LIMIT ${pageSize}) RETURNING operation_id,request,outcome`;

  yield* Effect.forEach(
    ack,
    Effect.fnUntraced(function* (row) {
      const request = yield* Schema.decodeUnknownEffect(requestCodec)(row.request);

      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        request,
        outcome: row.outcome,
      });

      const reply = yield* Effect.result(
        Effect.tryPromise(() =>
          env.PRICING.getByName(pricingName).fetch("https://pricing.internal/ack", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          })
        )
      );

      if (Result.isSuccess(reply) && reply.success.ok) {
        yield* sql`UPDATE billing_admissions SET ack_due_ms=NULL WHERE operation_id=${row.operation_id} AND outcome=${row.outcome}`;
      }
    }),
    { discard: true }
  );
});
