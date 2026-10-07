import { Clock, Context, Effect, Exit, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { BillingEmail } from "../../../src/core/subscription/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { makeResendOutboundHttp } from "../../../src/shell/outbound-http/operations";
import {
  cloudflareWorkerTelemetry,
  observeProviderFetch,
} from "../../runtime/telemetry/operations";
import {
  BillingCollectionFailure,
  type BillingPriceNoticeDispatchInput,
  BillingPriceNoticeWork,
  type BillingRuntime,
  type BillingWorkflowStarter,
} from "../contract";

const unavailable = (cause: unknown): BillingCollectionFailure =>
  new BillingCollectionFailure({ cause: Option.some(cause) });
const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A, BillingCollectionFailure> =>
  Effect.tryPromise({ try: run, catch: unavailable });
const Notice = Schema.Struct({
  billing_email: BillingEmail,
  amount: Schema.String,
  currency: Schema.Literal("COP"),
});
const NoticeEmail = Schema.Struct({
  from: Schema.String,
  to: Schema.Array(BillingEmail),
  subject: Schema.String,
  text: Schema.String,
});
const maximumReceiptIdLength = 128;
const noticeOfferCooldownMs = 60_000;
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const Receipt = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumReceiptIdLength)),
});

export const dispatchPriceNotices = (
  input: BillingPriceNoticeDispatchInput
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const discovery = protectConsentStatement({
      subject: { _tag: "Owner", column: "o.user_id" },
      requirement: "active",
      statement: {
        sql: `SELECT o.user_id, o.price_id FROM billing_price_notices o WHERE o.send_started_at_ms IS NULL
      AND (o.last_offered_at_ms IS NULL OR o.last_offered_at_ms < ?)`,
        params: [now - noticeOfferCooldownMs],
      },
    });
    const result = yield* fromPromise(() =>
      input.DB.prepare(`${discovery.sql} ORDER BY o.created_at_ms, o.user_id LIMIT 32`)
        .bind(...discovery.params)
        .all()
    );
    const entries = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          user_id: BillingPriceNoticeWork.fields.userId,
          price_id: BillingPriceNoticeWork.fields.priceId,
        })
      )
    )(result.results).pipe(Effect.mapError(unavailable));
    for (const entry of entries) {
      const claimed = yield* fromPromise(() =>
        input.DB.prepare(`UPDATE billing_price_notices SET last_offered_at_ms = ?
      WHERE user_id = ? AND price_id = ? AND send_started_at_ms IS NULL
      AND (last_offered_at_ms IS NULL OR last_offered_at_ms < ?)`)
          .bind(now, entry.user_id, entry.price_id, now - noticeOfferCooldownMs)
          .run()
      );
      if (claimed.meta.changes !== 1) continue;
      yield* fromPromise(() =>
        input.BILLING_COLLECTION_QUEUE.send({
          version: 1,
          kind: "price-notice",
          userId: entry.user_id,
          priceId: entry.price_id,
        })
      );
    }
  }).pipe(Effect.withSpan("billing.priceNotice.dispatch"));

const deliverPriceNotice = (
  input: Readonly<{
    environment: BillingRuntime & Readonly<{ RESEND_API_KEY: string }>;
    work: typeof BillingPriceNoticeWork.Type;
    notice: typeof Notice.Type;
  }>
): Effect.Effect<"accepted" | "refused", BillingCollectionFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { environment, work, notice } = input;
      const services = yield* Layer.build(FetchHttpClient.layer).pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          observeProviderFetch(globalThis.fetch, {
            provider: "resend",
            environment,
            telemetry: cloudflareWorkerTelemetry,
          })
        )
      );
      const outbound = makeResendOutboundHttp({
        apiKey: Redacted.make(environment.RESEND_API_KEY),
        httpClient: Context.get(services, HttpClient.HttpClient),
      });
      const response = yield* outbound
        .execute({
          _tag: "ResendEmailDelivery",
          idempotencyKey: `price-${work.priceId}-${work.userId}`,
          body: yield* Schema.encodeEffect(Schema.fromJsonString(NoticeEmail))({
            from: "Fidy <obarboza@fidyapp.com>",
            to: [notice.billing_email],
            subject: "El precio de tu suscripción semanal cambió",
            text: `El nuevo precio de tu suscripción semanal es ${notice.amount} COP. Se aplicará a los próximos cobros que aún no hayan comenzado. Los cobros pendientes conservan su precio. No necesitas aceptar de nuevo. Puedes cancelar las renovaciones futuras.`,
          }).pipe(Effect.mapError(unavailable)),
        })
        .pipe(Effect.timeout("14 seconds"), Effect.mapError(unavailable));
      if (
        response.status < successfulStatusMinimum ||
        response.status >= successfulStatusMaximumExclusive
      ) {
        return "refused" as const;
      }
      yield* Schema.decodeEffect(Schema.fromJsonString(Receipt))(
        new TextDecoder().decode(response.body)
      ).pipe(Effect.mapError(unavailable));
      return "accepted" as const;
    })
  );

const recordNoticeDelivery = (
  input: Readonly<{
    db: D1Database;
    work: typeof BillingPriceNoticeWork.Type;
    startedAt: number;
    delivery: "accepted" | "refused";
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const { db, work, startedAt, delivery } = input;
    if (delivery === "refused") {
      yield* fromPromise(() =>
        db
          .prepare(
            "UPDATE billing_price_notices SET send_started_at_ms=NULL WHERE user_id=? AND price_id=? AND send_started_at_ms=? AND accepted_at_ms IS NULL"
          )
          .bind(work.userId, work.priceId, startedAt)
          .run()
      );
      return yield* unavailable("provider-refused");
    }
    const acceptedAt = yield* Clock.currentTimeMillis;
    yield* fromPromise(() =>
      db
        .prepare(
          "UPDATE billing_price_notices SET accepted_at_ms=? WHERE user_id=? AND price_id=? AND accepted_at_ms IS NULL"
        )
        .bind(acceptedAt, work.userId, work.priceId)
        .run()
    );
  });

export const sendPriceNotice = (
  input: Readonly<{ environment: BillingRuntime; work: typeof BillingPriceNoticeWork.Type }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { environment, work } = input;
      if (environment.RESEND_API_KEY === undefined || environment.RESEND_API_KEY.length === 0) {
        return yield* unavailable("missing-provider");
      }
      const row = yield* fromPromise(() =>
        environment.DB.prepare(`SELECT source.billing_email, price.amount, price.currency
    FROM billing_price_notices notice JOIN subscription_prices price ON price.id=notice.price_id
    JOIN subscriptions subscription ON subscription.user_id=notice.user_id
    JOIN billing_attempts attempt ON attempt.id=subscription.attempt_id AND attempt.user_id=notice.user_id
    JOIN card_payment_sources source ON source.id=attempt.payment_source_id AND source.user_id=notice.user_id
    WHERE notice.user_id=? AND notice.price_id=? AND notice.send_started_at_ms IS NULL`)
          .bind(work.userId, work.priceId)
          .first()
      );
      if (row === null) return;
      const notice = yield* Schema.decodeUnknownEffect(Notice)(row).pipe(
        Effect.mapError(unavailable)
      );
      const now = yield* Clock.currentTimeMillis;
      const claim = protectConsentStatement({
        subject: { _tag: "User", userId: work.userId },
        requirement: "active",
        statement: {
          sql: `UPDATE billing_price_notices SET send_started_at_ms=? WHERE user_id=? AND price_id=? AND send_started_at_ms IS NULL`,
          params: [now, work.userId, work.priceId],
        },
      });
      const claimed = yield* fromPromise(() =>
        environment.DB.prepare(claim.sql)
          .bind(...claim.params)
          .run()
      );
      if (claimed.meta.changes !== 1) return;
      const delivery = yield* deliverPriceNotice({
        environment: { ...environment, RESEND_API_KEY: environment.RESEND_API_KEY },
        work,
        notice,
      });
      yield* recordNoticeDelivery({ db: environment.DB, work, startedAt: now, delivery });
    })
  ).pipe(Effect.withSpan("billing.priceNotice.send"));

/** Validate retained same-User intent before allocating its deterministic Workflow identity. */
export const receivePriceNotice = (
  input: Readonly<{
    environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: BillingWorkflowStarter }>;
    work: typeof BillingPriceNoticeWork.Type;
  }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const { environment, work } = input;
    const pending = yield* fromPromise(() =>
      environment.DB.prepare(
        "SELECT last_offered_at_ms FROM billing_price_notices WHERE user_id=? AND price_id=? AND send_started_at_ms IS NULL"
      )
        .bind(work.userId, work.priceId)
        .first()
    );
    if (pending === null) return;
    const offer = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ last_offered_at_ms: Schema.NullOr(Schema.Int) })
    )(pending).pipe(Effect.mapError(unavailable));
    const id = `price-v1-${work.priceId}-${work.userId}-${offer.last_offered_at_ms ?? 0}`;
    const started = yield* Effect.exit(
      fromPromise(() =>
        environment.BILLING_COLLECTION_WORKFLOW.create({
          id,
          params: work,
          retention: { successRetention: "3 days", errorRetention: "3 days" },
        })
      )
    );
    if (Exit.isFailure(started)) {
      yield* fromPromise(() => environment.BILLING_COLLECTION_WORKFLOW.get(id));
    }
  });
