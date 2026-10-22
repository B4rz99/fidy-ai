import { captureTraceHeaders } from "../../runtime/telemetry/operations";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { workerCrypto } from "./wompi-runtime";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import {
  BillingAttemptId,
  BillingPeriod,
  renewalGraceMs,
} from "../../../src/core/subscription/contract";
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
const renewalAdmissionJson = Schema.fromJsonString(SubscriptionRenewalAdmission);

const unresolvedCollectionSql = (userColumn: "s.user_id" | "sub.user_id"): string => `EXISTS (
  SELECT 1 FROM billing_attempt_context unresolved WHERE unresolved.user_id=${userColumn}
    AND (unresolved.status='pending' OR (unresolved.status='failed' AND unresolved.previous_paid_attempt_id IS NULL))
    AND unresolved.no_charge_confirmed_at_ms IS NULL
    AND NOT (unresolved.collection_state='rejected'
      AND unresolved.previous_paid_attempt_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM billing_attempt_context success WHERE success.paid_starts_at_ms IS NOT NULL
        AND success.previous_paid_attempt_id=unresolved.previous_paid_attempt_id)))`;

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
      sql: `INSERT INTO billing_attempts (id, subscription_id, enrollment_id, payment_request_id, payment_source_id, price_id, time_zone, wompi_environment, wompi_reference, created_at_ms, previous_paid_attempt_id, period_starts_at_ms, period_ends_at_ms, renewal_attempt_number, calendar_anchor_ms) SELECT ?, (SELECT id FROM subscriptions WHERE user_id=a.user_id), a.enrollment_id, ?, a.payment_source_id, price.id, a.time_zone, a.wompi_environment, ?, ?, a.id, ?, ?, 1, COALESCE(a.calendar_anchor_ms, a.paid_starts_at_ms) FROM subscription_standing s JOIN billing_attempt_context a ON a.id = s.attempt_id AND a.paid_starts_at_ms IS NOT NULL AND a.user_id = s.user_id
      JOIN payment_source_context source ON source.id = a.payment_source_id AND source.user_id = a.user_id
      JOIN subscription_prices price ON price.published_order IS NOT NULL AND price.billing_period = a.billing_period AND price.service_market = a.service_market
      WHERE s.user_id = ? AND a.id = ?
        AND a.wompi_environment = ? AND a.status = 'succeeded'
        AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id = s.user_id)
        AND NOT EXISTS (SELECT 1 FROM billing_attempt_context renewal WHERE renewal.previous_paid_attempt_id = a.id)
        AND NOT (${unresolvedCollectionSql("s.user_id")})`,
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

const prepareRetryClaim = (input: RenewalClaimInput & Readonly<{ id: string }>): OwnedStatement =>
  protectConsentStatement({
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `INSERT INTO billing_attempts (id, subscription_id, enrollment_id, payment_request_id, payment_source_id, price_id, time_zone, wompi_environment, wompi_reference, created_at_ms, previous_paid_attempt_id, period_starts_at_ms, period_ends_at_ms, renewal_attempt_number, calendar_anchor_ms) SELECT ?, (SELECT id FROM subscriptions WHERE user_id=first.user_id), first.enrollment_id, ?, first.payment_source_id, first.price_id, first.time_zone, first.wompi_environment, ?, ?, first.previous_paid_attempt_id, first.period_starts_at_ms, first.period_ends_at_ms, last.renewal_attempt_number+1, first.calendar_anchor_ms FROM billing_attempt_context first JOIN billing_attempt_context last ON last.previous_paid_attempt_id=first.previous_paid_attempt_id
          JOIN subscription_standing sub ON sub.attempt_id=first.previous_paid_attempt_id AND sub.user_id=first.user_id
          WHERE first.user_id=? AND first.previous_paid_attempt_id=? AND first.renewal_attempt_number=1
            AND first.wompi_environment=? AND last.status='failed' AND last.renewal_attempt_number<3
            AND ? >= first.period_starts_at_ms + last.renewal_attempt_number * 86400000
            AND ? < first.period_starts_at_ms + ${renewalGraceMs}
            AND NOT EXISTS (SELECT 1 FROM billing_attempt_context sibling WHERE sibling.previous_paid_attempt_id=first.previous_paid_attempt_id
              AND (sibling.status<>'failed' OR sibling.renewal_attempt_number>last.renewal_attempt_number))
            AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id=sub.user_id)
            AND NOT (${unresolvedCollectionSql("sub.user_id")})`,
      params: [
        input.id,
        input.id,
        `fidy-${input.id}`,
        input.now,
        input.userId,
        input.previousPaidAttemptId,
        input.environment,
        input.now,
        input.now,
      ],
    },
  });

export const claimSubscriptionRenewal = (
  input: RenewalClaimInput
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const row = yield* fromPromise(() =>
      input.db
        .prepare(`SELECT a.paid_ends_at_ms AS ends_at_ms, a.time_zone, a.billing_period, COALESCE(a.calendar_anchor_ms, a.paid_starts_at_ms) AS calendar_anchor_ms
    FROM subscription_standing s JOIN billing_attempt_context a ON a.id = s.attempt_id AND a.paid_starts_at_ms IS NOT NULL AND a.user_id = s.user_id
    WHERE s.user_id = ? AND a.id = ? AND a.status = 'succeeded'
    AND a.wompi_environment = ? AND a.paid_ends_at_ms <= ?`)
        .bind(input.userId, input.previousPaidAttemptId, input.environment, input.now)
        .first()
    );
    if (row === null) return;
    const boundary = yield* Schema.decodeUnknownEffect(Boundary)(row).pipe(
      Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
    );
    const retryId = yield* workerCrypto.randomUUIDv4().pipe(Effect.orDie);
    const retry = prepareRetryClaim({ ...input, id: retryId });
    yield* fromPromise(() =>
      input.db
        .prepare(retry.sql)
        .bind(...retry.params)
        .run()
    );
    const period = yield* renewalPeriod({
      timeZone: boundary.time_zone,
      billingPeriod: boundary.billing_period,
      originalStartsAt: DateTime.makeUnsafe(boundary.calendar_anchor_ms),
      previousEndsAt: DateTime.makeUnsafe(boundary.ends_at_ms),
    });
    const id = yield* workerCrypto.randomUUIDv4().pipe(Effect.orDie);
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
    FROM billing_attempt_context a JOIN subscription_standing s ON s.attempt_id = a.id AND a.user_id = s.user_id
    JOIN payment_source_context source ON source.id = a.payment_source_id AND source.user_id = a.user_id
    WHERE a.followup_due_at_ms <= ?
      AND a.wompi_environment = ?
      AND NOT EXISTS (SELECT 1 FROM subscription_renewal_fences stop WHERE stop.user_id = s.user_id)
      AND (NOT EXISTS (SELECT 1 FROM billing_attempt_context r WHERE r.previous_paid_attempt_id = a.id)
        OR EXISTS (SELECT 1 FROM billing_attempt_context r WHERE r.previous_paid_attempt_id = a.id AND r.status='failed'
          AND r.renewal_attempt_number < 3 AND ? >= r.period_starts_at_ms + r.renewal_attempt_number * 86400000
          AND ? < r.period_starts_at_ms + ${renewalGraceMs}
          AND NOT EXISTS (SELECT 1 FROM billing_attempt_context newer WHERE newer.previous_paid_attempt_id=a.id
            AND (newer.status<>'failed' OR newer.renewal_attempt_number>r.renewal_attempt_number))))
      AND NOT (${unresolvedCollectionSql("s.user_id")})
    `,
        params: [now, input.WOMPI_ENVIRONMENT, now, now],
      },
    });
    const result = yield* fromPromise(() =>
      input.DB.prepare(`${discovery.sql} ORDER BY a.followup_due_at_ms, a.id LIMIT 32`)
        .bind(...discovery.params)
        .all()
    );
    const entries = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserId, id: BillingAttemptId }))
    )(result.results).pipe(
      Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
    );
    const traceHeaders = yield* captureTraceHeaders;
    for (const entry of entries) {
      const encoded = yield* Schema.encodeEffect(renewalAdmissionJson)({
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
            headers: { "content-type": "application/json", ...traceHeaders },
            body: encoded,
            signal,
          })
        )
      );
      if (!response.ok) return yield* new BillingCollectionFailure({ cause: Option.none() });
    }
  }).pipe(Effect.withSpan("billing.renewal.dispatch"));
