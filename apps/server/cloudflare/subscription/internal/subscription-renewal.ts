import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { workerCrypto } from "./wompi-runtime";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { BillingAttemptId, BillingPeriod } from "../../../src/core/subscription/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { type PaidPeriodWindow, renewalPeriod } from "../../../src/core/subscription/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import {
  BillingCollectionFailure,
  SubscriptionRenewalAdmission,
  type SubscriptionRenewalDispatchInput,
} from "../contract";

const fromPromise = <A>(
  run: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, BillingCollectionFailure> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new BillingCollectionFailure({ cause: Option.some(cause) }),
  });
const Boundary = Schema.Struct({
  ends_at_ms: Schema.Int,
  time_zone: IanaTimeZone,
  billing_period: BillingPeriod,
  calendar_anchor_ms: Schema.Int,
});

type RenewalClaimInput = Readonly<{
  db: D1Database;
  userId: UserId;
  previousPaidAttemptId: BillingAttemptId;
  now: number;
  environment: string;
}>;
const prepareRenewalClaim = (
  input: RenewalClaimInput & Readonly<{ id: string; period: PaidPeriodWindow }>
): OwnedStatement => {
  const { id, period } = input;
  return protectConsentStatement({
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `INSERT INTO billing_attempts
      (id, user_id, enrollment_id, payment_request_id, payment_source_id, price_id, amount, currency,
      billing_period, service_market, tax_treatment, time_zone, wompi_environment, wompi_reference,
      created_at_ms, previous_paid_attempt_id, period_starts_at_ms, period_ends_at_ms, attempt_number, calendar_anchor_ms)
      SELECT ?, a.user_id, a.enrollment_id, ?, a.payment_source_id, price.id, price.amount, price.currency,
      price.billing_period, price.service_market, price.tax_treatment, a.time_zone, a.wompi_environment, ?, ?, a.id, ?, ?, 1, COALESCE(a.calendar_anchor_ms, period.starts_at_ms)
      FROM subscriptions s JOIN billing_attempts a ON a.id = s.attempt_id AND a.user_id = s.user_id
      JOIN billing_paid_periods period ON period.attempt_id = a.id
      JOIN card_payment_sources source ON source.id = a.payment_source_id AND source.user_id = a.user_id
      JOIN subscription_prices price ON price.published_order IS NOT NULL AND price.billing_period = a.billing_period AND price.service_market = a.service_market
      WHERE s.user_id = ? AND a.id = ?
        AND a.wompi_environment = ? AND a.status = 'succeeded'
        AND NOT EXISTS (SELECT 1 FROM subscription_renewal_stops stop WHERE stop.user_id = s.user_id)
        AND NOT EXISTS (SELECT 1 FROM billing_attempts renewal WHERE renewal.previous_paid_attempt_id = a.id)
        AND NOT EXISTS (SELECT 1 FROM billing_attempts unresolved WHERE unresolved.user_id = s.user_id AND unresolved.status <> 'succeeded'
          AND NOT EXISTS (SELECT 1 FROM billing_no_charge_confirmations clear WHERE clear.attempt_id = unresolved.id))`,
      params: [
        id,
        id,
        `fidy-${id}`,
        input.now,
        DateTime.toEpochMillis(period.startsAt),
        DateTime.toEpochMillis(period.endsAt),
        input.userId,
        input.previousPaidAttemptId,
        input.environment,
      ],
    },
  });
};

export const claimSubscriptionRenewal = (
  input: RenewalClaimInput
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const row = yield* fromPromise(() =>
      input.db
        .prepare(`SELECT p.ends_at_ms, a.time_zone, a.billing_period, COALESCE(a.calendar_anchor_ms, p.starts_at_ms) AS calendar_anchor_ms
    FROM subscriptions s JOIN billing_attempts a ON a.id = s.attempt_id AND a.user_id = s.user_id
    JOIN billing_paid_periods p ON p.attempt_id = a.id
    WHERE s.user_id = ? AND a.id = ? AND a.status = 'succeeded'
    AND a.wompi_environment = ? AND p.ends_at_ms <= ?`)
        .bind(input.userId, input.previousPaidAttemptId, input.environment, input.now)
        .first()
    );
    if (row === null) return;
    const boundary = yield* Schema.decodeUnknownEffect(Boundary)(row).pipe(
      Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
    );
    const period = yield* renewalPeriod({
      timeZone: boundary.time_zone,
      billingPeriod: boundary.billing_period,
      originalStartsAt: DateTime.makeUnsafe(boundary.calendar_anchor_ms),
      previousEndsAt: DateTime.makeUnsafe(boundary.ends_at_ms),
    });
    const id = yield* workerCrypto.randomUUIDv4.pipe(Effect.orDie);
    const statement = prepareRenewalClaim({ ...input, id, period });
    yield* fromPromise(() =>
      input.db
        .prepare(statement.sql)
        .bind(...statement.params)
        .run()
    );
  });

/** Discover only bounded identities; each admission rechecks same-User authority inside its coordinator. */
export const dispatchSubscriptionRenewals = (
  input: SubscriptionRenewalDispatchInput
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const discovery = protectConsentStatement({
      subject: { _tag: "Owner", column: "s.user_id" },
      requirement: "active",
      statement: {
        sql: `SELECT a.user_id, a.id
    FROM billing_followup_outbox due JOIN subscriptions s ON s.attempt_id = due.attempt_id
    JOIN billing_attempts a ON a.id = s.attempt_id AND a.user_id = s.user_id
    JOIN card_payment_sources source ON source.id = a.payment_source_id AND source.user_id = a.user_id
    WHERE due.due_at_ms <= ?
      AND a.wompi_environment = ?
      AND NOT EXISTS (SELECT 1 FROM subscription_renewal_stops stop WHERE stop.user_id = s.user_id)
      AND NOT EXISTS (SELECT 1 FROM billing_attempts r WHERE r.previous_paid_attempt_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM billing_attempts unresolved WHERE unresolved.user_id = s.user_id AND unresolved.status <> 'succeeded'
          AND NOT EXISTS (SELECT 1 FROM billing_no_charge_confirmations clear WHERE clear.attempt_id = unresolved.id))
    `,
        params: [now, input.WOMPI_ENVIRONMENT],
      },
    });
    const result = yield* fromPromise(() =>
      input.DB.prepare(`${discovery.sql} ORDER BY due.due_at_ms, a.id LIMIT 32`)
        .bind(...discovery.params)
        .all()
    );
    const entries = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserId, id: BillingAttemptId }))
    )(result.results).pipe(
      Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
    );
    for (const entry of entries) {
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(SubscriptionRenewalAdmission)
      )({
        _tag: "SubscriptionRenewal",
        userId: entry.user_id,
        previousPaidAttemptId: entry.id,
      }).pipe(
        Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
      );
      const response = yield* fromPromise((signal) =>
        input.USER_TRANSACTION_COORDINATOR.getByName(entry.user_id).fetch(
          new Request("https://coordinator.internal/subscription-renewal-work", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encoded,
            signal,
          })
        )
      );
      if (!response.ok) return yield* new BillingCollectionFailure({ cause: Option.none() });
    }
  }).pipe(Effect.withSpan("billing.renewal.dispatch"));
