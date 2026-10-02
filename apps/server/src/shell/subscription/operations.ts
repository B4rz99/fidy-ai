import { type PreparedSubscriptionRead, type SubscriptionReadAuthority } from "./contract";
import {
  subscriptionAttemptsQuery,
  subscriptionOffersQuery,
  subscriptionStandingQuery,
} from "~/shell/subscription/internal/query-sql";
import {
  projectSubscriptionOffers,
  projectSubscriptionStatus,
  listSubscriptionOffersResponse as readOffers,
  readSubscriptionStatus,
} from "~/shell/subscription/internal/queries";
import { Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/unstable/sql";
import { type UserId } from "~/core/identity/reference";
import { SubscriptionOffers, SubscriptionStatus } from "~/core/subscription/contract";
import { type OwnedStatement } from "~/shell/_shared/owned-statement";
import { type Unavailable } from "~/shell/public-http/contract";

/** Read the complete immutable published offer set, or fail closed if it is unavailable. */
export const listSubscriptionOffersResponse: Effect.Effect<
  { readonly data: SubscriptionOffers; readonly next: ReadonlyArray<never> },
  Unavailable,
  SqlClient.SqlClient
> = Effect.suspend(() => readOffers);

/** Read one User's original trial, settled paid standing and bounded safe BillingAttempts. */
export const getSubscriptionStatus = (
  userId: UserId
): Effect.Effect<
  { readonly data: SubscriptionStatus; readonly next: ReadonlyArray<never> },
  Unavailable,
  SqlClient.SqlClient
> => readSubscriptionStatus(userId);

/**
 * Recheck settled paid access at the caller's decision instant within its own protected unit.
 * The interval is half-open; another User's Subscription cannot establish this condition.
 */
export const activePaidSubscriptionCondition = ({
  userId,
  nowEpochMs,
}: Readonly<{ userId: UserId; nowEpochMs: number }>): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM subscriptions AS subscription
    WHERE subscription.user_id = ? AND subscription.paid_period_ends_at_ms > ?
    AND EXISTS (SELECT 1 FROM billing_paid_periods AS period
      WHERE period.attempt_id = subscription.attempt_id AND period.starts_at_ms <= ?))`,
  params: [userId, nowEpochMs, nowEpochMs],
});

/** Prepare complete public Prices with a live authority recheck and closed JSON projection. */
export const prepareSubscriptionOffers = (
  authority: SubscriptionReadAuthority
): PreparedSubscriptionRead => ({
  statements: [subscriptionOffersQuery(Option.some(authority))],
  decode: (rows) =>
    Schema.encodeSync(Schema.toCodecJson(SubscriptionOffers))(
      projectSubscriptionOffers(rows[0] ?? [])
    ),
});

/** Prepare one User's safe standing and attempts at the same decision instant as its protected read. */
export const prepareSubscriptionStatus = (
  input: Readonly<{
    userId: UserId;
    authority: SubscriptionReadAuthority;
    current: number;
  }>
): PreparedSubscriptionRead => ({
  statements: [
    subscriptionStandingQuery({ userId: input.userId, authority: Option.some(input.authority) }),
    subscriptionAttemptsQuery({ userId: input.userId, authority: Option.some(input.authority) }),
  ],
  decode: (rows) =>
    Schema.encodeSync(Schema.toCodecJson(SubscriptionStatus))(
      projectSubscriptionStatus({
        standingRow: rows[0]?.[0],
        attemptRows: rows[1] ?? [],
        now: input.current,
      })
    ),
});
