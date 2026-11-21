import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { OutboundHttpRequest } from "../../../src/shell/outbound-http/contract";
import { Clock, DateTime, Effect, Option, Result, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { BillingCollectionFailure, type LocalSourceCancellationWork } from "../contract";
import { WompiSourceId } from "./wompi-model";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { type OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import { verifyVoidedSource } from "./source-cancellation";
import { UserId } from "../../../src/core/identity/contract";
import {
  BillingAttemptId,
  SubscriptionCancellation,
} from "../../../src/core/subscription/contract";

const Cancelled = Schema.Struct({
  source_cancellation_state: SubscriptionCancellation.fields.sourceCancellation,
  cancelled_at_ms: Schema.Int,
  paid_through_ms: Schema.Int,
  next_offer_at_ms: Schema.NullOr(Schema.Int),
});

export const retainCancellation = Effect.fnUntraced(function* (
  input: Readonly<{
    userId: string;
    current: number;
    storage: DurableObjectStorage;
  }>
) {
  const sql = yield* SqliteClient;
  yield* sql`INSERT INTO subscription_cancellations
    (paid_attempt_id,subscription_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,next_offer_at_ms)
    SELECT a.id,s.id,src.id,${input.current},
      MIN(a.paid_ends_at_ms,COALESCE((SELECT MIN(r.access_ends_at_ms) FROM refund_attempts r WHERE r.billing_attempt_id=a.id),a.paid_ends_at_ms)),
      CASE src.method WHEN 'daviplata' THEN 'void-pending' ELSE 'detached' END,
      CASE src.method WHEN 'daviplata' THEN ${input.current} END
    FROM subscriptions s JOIN billing_attempts a ON a.id=s.current_paid_attempt_id AND a.subscription_id=s.id
    JOIN payment_sources src ON src.id=a.payment_source_id AND src.subscription_id=s.id
    WHERE s.user_id=${input.userId} AND a.paid_starts_at_ms IS NOT NULL AND src.method IS NOT NULL
      AND (src.method<>'daviplata' OR (src.wompi_source_id IS NOT NULL AND src.wompi_environment=a.wompi_environment))
      AND NOT EXISTS (SELECT 1 FROM erasure_requests WHERE user_id=s.user_id)
    ON CONFLICT(paid_attempt_id) DO NOTHING`;

  const rows =
    yield* sql`SELECT c.source_cancellation_state,c.cancelled_at_ms,c.paid_through_ms,c.next_offer_at_ms
    FROM subscription_cancellations c JOIN subscriptions s ON s.id=c.subscription_id AND s.current_paid_attempt_id=c.paid_attempt_id
    WHERE s.user_id=${input.userId} AND NOT EXISTS (SELECT 1 FROM erasure_requests WHERE user_id=s.user_id)`;

  if (rows.length === 0) {
    const paid = yield* sql`SELECT 1 FROM subscriptions s JOIN billing_attempts a
      ON a.id=s.current_paid_attempt_id AND a.subscription_id=s.id
      WHERE s.user_id=${input.userId} AND a.paid_starts_at_ms IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM erasure_requests WHERE user_id=s.user_id) LIMIT 1`;

    if (paid.length > 0) return yield* new BillingCollectionFailure({ cause: Option.none() });

    return Option.none<SubscriptionCancellation>();
  }

  const [row] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Cancelled]))(rows);

  if (row.next_offer_at_ms !== null) {
    yield* preserveStoreAlarm(input.storage, row.next_offer_at_ms);
  }

  return Option.some(
    SubscriptionCancellation.make({
      cancelledAt: DateTime.makeUnsafe(row.cancelled_at_ms),
      paidThrough: DateTime.makeUnsafe(row.paid_through_ms),
      sourceCancellation: row.source_cancellation_state,
    })
  );
});

const offerCooldownMs = 60_000;

const boundedOfferPage = 32;

const DueRow = Schema.Struct({ user_id: UserId, paid_attempt_id: BillingAttemptId });

export const repairCancellationAlarm = Effect.fnUntraced(function* (storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const remaining =
    yield* sql`SELECT next_offer_at_ms FROM subscription_cancellations c JOIN subscriptions s ON s.id=c.subscription_id
      WHERE next_offer_at_ms IS NOT NULL AND (c.void_started_at_ms IS NOT NULL OR NOT EXISTS (SELECT 1 FROM erasure_requests WHERE user_id=s.user_id)) ORDER BY next_offer_at_ms,paid_attempt_id LIMIT 1`;

  if (remaining.length > 0) {
    const [row] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ next_offer_at_ms: Schema.Int })])
    )(remaining);

    return yield* preserveStoreAlarm(storage, row.next_offer_at_ms);
  }

  return false;
});

export const dispatchCancellations = Effect.fnUntraced(function* (
  input: Readonly<{
    current: number;
    storage: DurableObjectStorage;
    queue: Readonly<{
      send: (work: typeof LocalSourceCancellationWork.Type) => Promise<QueueSendResponse | void>;
    }>;
  }>
) {
  const sql = yield* SqliteClient;

  const work = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const page = yield* sql`SELECT c.paid_attempt_id,s.user_id FROM subscription_cancellations c
      JOIN subscriptions s ON s.id=c.subscription_id
      WHERE c.next_offer_at_ms<=${input.current} AND c.source_cancellation_state='void-pending'
      AND c.verification_count<8
      AND (c.void_started_at_ms IS NOT NULL OR NOT EXISTS (SELECT 1 FROM erasure_requests WHERE user_id=s.user_id))
      ORDER BY c.next_offer_at_ms,c.paid_attempt_id LIMIT ${boundedOfferPage}`;

      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(DueRow))(page);

      yield* Effect.forEach(
        rows,
        Effect.fnUntraced(function* (row) {
          yield* sql`UPDATE subscription_cancellations SET next_offer_at_ms=${input.current + offerCooldownMs}
        WHERE paid_attempt_id=${row.paid_attempt_id}`;
        }),
        { discard: true }
      );

      yield* repairCancellationAlarm(input.storage);

      return rows;
    })
  );

  const offered = yield* Effect.forEach(
    work,
    (row) =>
      Effect.tryPromise(() =>
        input.queue.send({
          version: 3,
          kind: "source-cancellation",
          userId: row.user_id,
          paidAttemptId: row.paid_attempt_id,
        })
      ).pipe(Effect.timeout("5 seconds"), Effect.result),
    { concurrency: 4 }
  );

  return { attempted: work.length, failed: offered.filter(Result.isFailure).length };
});

const Claim = Schema.Struct({
  wompi_source_id: WompiSourceId,
  wompi_environment: WompiEnvironment,
  void_started_at_ms: Schema.NullOr(Schema.Int),
  verification_count: Schema.Int,
});

export const observeCancellation = Effect.fnUntraced(function* (
  input: Readonly<{
    work: typeof LocalSourceCancellationWork.Type;
    current: number;
    environment: WompiEnvironment;
    http: OutboundHttpService;
  }>
) {
  const sql = yield* SqliteClient;
  const { work, current } = input;

  const claim = yield* withStoreCapacity("required")(
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT src.wompi_source_id,src.wompi_environment,c.void_started_at_ms,c.verification_count
      FROM subscription_cancellations c JOIN subscriptions s ON s.id=c.subscription_id
      JOIN billing_attempts a ON a.id=c.paid_attempt_id AND a.subscription_id=s.id AND a.payment_source_id=c.payment_source_id
      JOIN payment_sources src ON src.id=c.payment_source_id AND src.subscription_id=s.id AND src.wompi_environment=a.wompi_environment
      WHERE c.paid_attempt_id=${work.paidAttemptId} AND s.user_id=${work.userId} AND src.method='daviplata'
      AND c.source_cancellation_state='void-pending' AND c.verification_count<8
      AND (c.next_verification_at_ms IS NULL OR c.next_verification_at_ms<=${current})
      AND (c.void_started_at_ms IS NOT NULL OR NOT EXISTS (SELECT 1 FROM erasure_requests WHERE user_id=s.user_id))`;

      if (rows.length === 0) return Option.none<typeof Claim.Type>();
      const [source] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Claim]))(rows);

      if (source.wompi_environment !== input.environment) {
        return yield* new BillingCollectionFailure({ cause: Option.none() });
      }

      yield* sql`UPDATE subscription_cancellations SET verification_count=verification_count+1,
      void_started_at_ms=COALESCE(void_started_at_ms,${current}),next_verification_at_ms=${current + offerCooldownMs},
      next_offer_at_ms=CASE WHEN verification_count=7 THEN NULL ELSE next_offer_at_ms END
      WHERE paid_attempt_id=${work.paidAttemptId}`;

      return Option.some(source);
    })
  );

  if (Option.isNone(claim)) return;
  const source = claim.value;

  if (source.void_started_at_ms === null) {
    yield* input.http
      .execute(OutboundHttpRequest.WompiVoidPaymentSource({ sourceId: source.wompi_source_id }))
      .pipe(Effect.tapError(Effect.logDebug), Effect.ignore);
  }

  if (!(yield* verifyVoidedSource(input.http, source.wompi_source_id))) return;
  const verifiedAt = yield* Clock.currentTimeMillis;
  yield* withStoreCapacity(
    "required"
  )(sql`UPDATE subscription_cancellations SET source_cancellation_state='voided',
    void_verified_at_ms=${verifiedAt},next_offer_at_ms=NULL,next_verification_at_ms=NULL
    WHERE paid_attempt_id=${work.paidAttemptId} AND source_cancellation_state='void-pending' AND void_started_at_ms IS NOT NULL
    AND EXISTS (SELECT 1 FROM payment_sources src JOIN subscriptions s ON s.id=src.subscription_id
      JOIN billing_attempts a ON a.id=subscription_cancellations.paid_attempt_id AND a.subscription_id=s.id
        AND a.payment_source_id=src.id AND a.wompi_environment=src.wompi_environment
      WHERE src.id=subscription_cancellations.payment_source_id AND s.id=subscription_cancellations.subscription_id
        AND s.user_id=${work.userId} AND src.wompi_source_id=${source.wompi_source_id} AND src.wompi_environment=${source.wompi_environment})`);
});

export const pendingCancellation = Effect.fnUntraced(function* (
  work: typeof LocalSourceCancellationWork.Type
) {
  const sql = yield* SqliteClient;

  const rows =
    yield* sql`SELECT 1 FROM subscription_cancellations c JOIN subscriptions s ON s.id=c.subscription_id
    WHERE s.user_id=${work.userId} AND c.paid_attempt_id=${work.paidAttemptId}
    AND c.source_cancellation_state='void-pending' AND c.verification_count<8
    AND (c.void_started_at_ms IS NOT NULL OR NOT EXISTS (SELECT 1 FROM erasure_requests WHERE user_id=s.user_id))`;

  return rows.length === 1;
});

export const cancellationReview = Effect.fn(function* (user: string) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT a.id AS attempt,src.id AS source,src.method,MIN(a.paid_ends_at_ms,COALESCE((SELECT MIN(r.access_ends_at_ms) FROM refund_attempts r WHERE r.billing_attempt_id=a.id),a.paid_ends_at_ms)) AS paid FROM subscriptions s JOIN billing_attempts a ON a.id=s.current_paid_attempt_id AND a.subscription_id=s.id JOIN payment_sources src ON src.id=a.payment_source_id AND src.subscription_id=s.id WHERE s.user_id=${user} AND a.paid_starts_at_ms IS NOT NULL`;

  const value = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      attempt: Schema.String,
      source: Schema.String,
      method: Schema.String,
      paid: Schema.Int,
    })
  )(row);

  return {
    revision: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value),
    effect: `Cancelar futuras renovaciones de Pro. Conservar acceso pagado hasta ${DateTime.formatIso(DateTime.makeUnsafe(value.paid))}. Desvincular el medio de pago reutilizable.`,
  };
});
