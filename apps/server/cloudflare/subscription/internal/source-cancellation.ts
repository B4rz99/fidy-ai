import { captureWorkTrace, sanitizeWorkTrace } from "../../runtime/telemetry/operations";
import { Clock, Effect, Option, Schema } from "effect";
import { WompiEnvironment } from "../../../src/shell/secret-material/contract";
import { UnknownJsonString } from "../../../src/shell/schema-codecs/contract";
import { UserId } from "../../../src/core/identity/contract";
import {
  BillingCollectionFailure,
  type BillingRuntime,
  type BillingWorkflowStarter,
  type SubscriptionCancellationDispatchInput,
  type SubscriptionCancellationWork,
} from "../contract";
import { WompiSourceId } from "./wompi-model";
import { type WompiTransportFactory } from "./wompi-runtime";

const wait = <A>(run: () => Promise<A>): Effect.Effect<A, BillingCollectionFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BillingCollectionFailure({ cause: Option.some(cause) }),
  });
const decode = <A, E>(
  schema: Schema.Codec<A, E>,
  value: unknown
): Effect.Effect<A, BillingCollectionFailure> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
  );
const Snapshot = Schema.Struct({
  wompi_source_id: WompiSourceId,
  wompi_environment: WompiEnvironment,
  void_started_at_ms: Schema.OptionFromNullOr(Schema.Int),
});
const Source = Schema.Struct({
  data: Schema.Struct({
    id: WompiSourceId,
    type: Schema.Literal("DAVIPLATA"),
    status: Schema.Literals(["AVAILABLE", "VOIDED"]),
  }),
});
const offerCooldownMs = 60_000;
const httpSuccessMinimum = 200;
const httpSuccessMaximum = 300;
const retention = { successRetention: "3 days", errorRetention: "3 days" } as const;

export const dispatchCancellations = (
  input: SubscriptionCancellationDispatchInput
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const trace = yield* captureWorkTrace;
    const now = yield* Clock.currentTimeMillis;
    const result = yield* wait(() =>
      input.DB.prepare(`SELECT user_id FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) WHERE source_cancellation='void-pending'
    AND verification_count<8 AND (last_offered_at_ms IS NULL OR last_offered_at_ms<?) ORDER BY last_offered_at_ms,user_id LIMIT 32`)
        .bind(now - offerCooldownMs)
        .all()
    );
    const rows = yield* decode(Schema.Array(Schema.Struct({ user_id: UserId })), result.results);
    for (const row of rows) {
      yield* wait(() =>
        input.DB.prepare("UPDATE users SET cancellation_last_offered_at_ms=? WHERE id=?")
          .bind(now, row.user_id)
          .run()
      );
      yield* wait(() =>
        input.BILLING_COLLECTION_QUEUE.send({
          ...trace,
          version: 1,
          kind: "source-cancellation",
          userId: row.user_id,
        })
      );
    }
  });
export const receiveCancellation = (
  input: Readonly<{
    db: D1Database;
    workflow: BillingWorkflowStarter;
    work: typeof SubscriptionCancellationWork.Type;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const row = yield* wait(() =>
      input.db
        .prepare(
          "SELECT last_offered_at_ms FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) WHERE user_id=? AND source_cancellation='void-pending' AND verification_count<8"
        )
        .bind(input.work.userId)
        .first()
    );
    if (row === null) return;
    const offer = yield* decode(
      Schema.Struct({ last_offered_at_ms: Schema.NullOr(Schema.Int) }),
      row
    );
    const id = `source-cancel-v1-${input.work.userId}-${offer.last_offered_at_ms ?? 0}`;
    const params = yield* sanitizeWorkTrace(input.work);
    yield* wait(() => input.workflow.create({ id, params, retention })).pipe(
      Effect.catch(() => wait(() => input.workflow.get(id)))
    );
  });

type SourceCancellationInput = Readonly<{
  environment: BillingRuntime;
  work: typeof SubscriptionCancellationWork.Type;
  wompiHttp: WompiTransportFactory;
}>;

export const cancelSource = (
  input: SourceCancellationInput
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const { DB: db } = input.environment;
    const row = yield* wait(() =>
      db
        .prepare(`SELECT source.wompi_source_id,a.wompi_environment,c.void_started_at_ms
    FROM (SELECT rowid,id AS user_id,cancellation_paid_attempt_id AS paid_attempt_id,cancellation_payment_source_id AS payment_source_id,cancellation_cancelled_at_ms AS cancelled_at_ms,cancellation_paid_through_ms AS paid_through_ms,cancellation_source_cancellation AS source_cancellation,cancellation_void_started_at_ms AS void_started_at_ms,cancellation_void_verified_at_ms AS void_verified_at_ms,cancellation_verification_count AS verification_count,cancellation_last_offered_at_ms AS last_offered_at_ms FROM users WHERE cancellation_cancelled_at_ms IS NOT NULL) c JOIN card_payment_sources source ON source.id=c.payment_source_id AND source.user_id=c.user_id
    JOIN billing_attempts a ON a.id=c.paid_attempt_id AND a.user_id=c.user_id
    WHERE c.user_id=? AND source.method='daviplata' AND c.source_cancellation='void-pending' AND c.verification_count<8`)
        .bind(input.work.userId)
        .first()
    );
    if (row === null) return;
    const source = yield* decode(Snapshot, row);
    if (source.wompi_environment !== input.environment.WOMPI_ENVIRONMENT) {
      return yield* new BillingCollectionFailure({ cause: Option.none() });
    }
    const http = yield* input.wompiHttp({
      ...input.environment,
      WOMPI_ENVIRONMENT: source.wompi_environment,
    });
    const now = yield* Clock.currentTimeMillis;
    yield* submitVoid({ db, userId: input.work.userId, source, http, now });
    const reservation = yield* wait(() =>
      db
        .prepare(
          "UPDATE users SET cancellation_verification_count=cancellation_verification_count+1 WHERE id=? AND cancellation_source_cancellation='void-pending' AND cancellation_verification_count<8"
        )
        .bind(input.work.userId)
        .run()
    );
    if (reservation.meta.changes !== 1) return;
    const response = yield* http
      .execute({ _tag: "WompiVerifyPaymentSource", sourceId: source.wompi_source_id })
      .pipe(
        Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
      );
    if (response.status < httpSuccessMinimum || response.status >= httpSuccessMaximum) {
      return yield* new BillingCollectionFailure({ cause: Option.none() });
    }
    const body = yield* decode(UnknownJsonString, new TextDecoder().decode(response.body));
    const verified = yield* decode(Source, body);
    if (verified.data.id !== source.wompi_source_id) {
      return yield* new BillingCollectionFailure({ cause: Option.none() });
    }
    if (verified.data.status === "VOIDED") {
      yield* wait(() =>
        db
          .prepare(
            "UPDATE users SET cancellation_source_cancellation='voided',cancellation_void_verified_at_ms=? WHERE id=? AND cancellation_source_cancellation='void-pending'"
          )
          .bind(now, input.work.userId)
          .run()
      );
    }
  });

const submitVoid = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    source: typeof Snapshot.Type;
    http: Effect.Success<ReturnType<WompiTransportFactory>>;
    now: number;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    if (Option.isNone(input.source.void_started_at_ms)) {
      const claim = yield* wait(() =>
        input.db
          .prepare(
            "UPDATE users SET cancellation_void_started_at_ms=? WHERE id=? AND cancellation_void_started_at_ms IS NULL AND cancellation_source_cancellation='void-pending'"
          )
          .bind(input.now, input.userId)
          .run()
      );
      if (claim.meta.changes === 1) {
        yield* input.http
          .execute({ _tag: "WompiVoidPaymentSource", sourceId: input.source.wompi_source_id })
          .pipe(Effect.ignore);
      }
    }
  });
