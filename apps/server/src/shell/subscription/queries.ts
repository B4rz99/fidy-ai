import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import { Price, SubscriptionOffers, SubscriptionStatus } from "~/core/subscription/model";
import { Unavailable } from "~/shell/public-http/contract";
import {
  subscriptionAttemptsQuery,
  subscriptionOffersQuery,
  subscriptionStandingQuery,
} from "./query-sql";

const PriceRow = Schema.Struct({
  id: Price.fields.id,
  amount: Schema.String,
  currency: Schema.String,
  billing_period: Schema.String,
  service_market: Schema.String,
  tax_treatment: Schema.String,
  terms_json: Schema.String,
});
const Terms = Schema.Struct({
  ...Price.fields.renewalTerms.fields,
  paymentMethods: Price.fields.paymentMethods,
});
const StandingRow = Schema.Struct({
  started_at_ms: Schema.Finite,
  trial_ends_at_ms: Schema.Finite,
  price_id: Schema.NullOr(Schema.String),
  amount: Schema.NullOr(Schema.String),
  currency: Schema.NullOr(Schema.String),
  billing_period: Schema.NullOr(Schema.String),
  service_market: Schema.NullOr(Schema.String),
  tax_treatment: Schema.NullOr(Schema.String),
  starts_at_ms: Schema.NullOr(Schema.Finite),
  ends_at_ms: Schema.NullOr(Schema.Finite),
  renewal_anchor_ms: Schema.NullOr(Schema.Finite),
});
const AttemptRow = Schema.Struct({
  id: Schema.String,
  price_id: Schema.String,
  amount: Schema.String,
  currency: Schema.String,
  billing_period: Schema.String,
  service_market: Schema.String,
  tax_treatment: Schema.String,
  time_zone: Schema.String,
  created_at_ms: Schema.Finite,
  status: Schema.String,
  finalized_at_ms: Schema.NullOr(Schema.Finite),
  ends_at_ms: Schema.NullOr(Schema.Finite),
  renewal_anchor_ms: Schema.NullOr(Schema.Finite),
});
const decode = <A, E>(schema: Schema.Codec<A, E>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value);
const instant = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));
const unavailable = (): Unavailable =>
  Unavailable.make({
    error: {
      code: "unavailable",
      message: "Subscription data is temporarily unavailable. Retry later.",
    },
    next: [],
  });

/** Validate published Price rows as one ordered, immutable offer set. */
export const projectSubscriptionOffers = (rows: ReadonlyArray<unknown>): SubscriptionOffers =>
  decode(
    Schema.toCodecJson(SubscriptionOffers),
    rows.map((raw) => {
      const row = decode(PriceRow, raw);
      const terms = decode(Schema.fromJsonString(Terms), row.terms_json);
      return {
        id: row.id,
        money: { amount: row.amount, currency: row.currency },
        billingPeriod: row.billing_period,
        serviceMarket: row.service_market,
        taxTreatment: row.tax_treatment,
        renewalTerms: terms,
        paymentMethods: terms.paymentMethods,
      };
    })
  );

/** Load only published immutable Prices, validating the complete ordered offer set. */
export const listSubscriptionOffersResponse = Effect.flatMap(SqlClient.SqlClient, (sql) => {
  const query = subscriptionOffersQuery();
  return sql.unsafe(query.sql, query.params);
}).pipe(
  Effect.map((rows) => ({ data: projectSubscriptionOffers(rows), next: [] as const })),
  Effect.mapError(unavailable),
  Effect.catchDefect(() => Effect.fail(unavailable()))
);

/** Read one User's trial, paid period, and bounded attempts at the same decision instant. */
export const getSubscriptionStatus = (
  userId: UserId
): Effect.Effect<
  { readonly data: SubscriptionStatus; readonly next: ReadonlyArray<never> },
  Unavailable,
  SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    const standingQuery = subscriptionStandingQuery({ userId, authority: Option.none() });
    const attemptsQuery = subscriptionAttemptsQuery({ userId, authority: Option.none() });
    const standing = yield* sql.unsafe(standingQuery.sql, standingQuery.params);
    const attempts = yield* sql.unsafe(attemptsQuery.sql, attemptsQuery.params);
    return {
      data: projectSubscriptionStatus({ standingRow: standing[0], attemptRows: attempts, now }),
      next: [] as const,
    };
  }).pipe(
    Effect.mapError(unavailable),
    Effect.catchDefect(() => Effect.fail(unavailable()))
  );

const projectAttempt = (raw: unknown): unknown => {
  const attempt = decode(AttemptRow, raw);
  const snapshot = {
    id: attempt.id,
    priceId: attempt.price_id,
    money: { amount: attempt.amount, currency: attempt.currency },
    billingPeriod: attempt.billing_period,
    serviceMarket: attempt.service_market,
    taxTreatment: attempt.tax_treatment,
    timeZone: attempt.time_zone,
    createdAt: instant(attempt.created_at_ms),
  };
  if (attempt.status === "pending") return { ...snapshot, status: "pending" };
  if (attempt.status === "failed") {
    return {
      ...snapshot,
      status: "failed",
      failedAt: instant(decode(Schema.Finite, attempt.finalized_at_ms)),
    };
  }
  return {
    ...snapshot,
    status: "succeeded",
    finalizedAt: instant(decode(Schema.Finite, attempt.finalized_at_ms)),
    paidPeriodEndsAt: instant(decode(Schema.Finite, attempt.ends_at_ms)),
    renewalAnchor: instant(decode(Schema.Finite, attempt.renewal_anchor_ms)),
  };
};

/** Build a closed User-specific standing projection from decoded authoritative rows. */
export const projectSubscriptionStatus = ({
  standingRow,
  attemptRows,
  now,
}: Readonly<{
  standingRow: unknown;
  attemptRows: ReadonlyArray<unknown>;
  now: number;
}>): SubscriptionStatus => {
  const row = decode(StandingRow, standingRow);
  const paidSubscription =
    row.price_id === null
      ? null
      : {
          priceId: row.price_id,
          money: { amount: row.amount, currency: row.currency },
          billingPeriod: row.billing_period,
          serviceMarket: row.service_market,
          taxTreatment: row.tax_treatment,
          startsAt: instant(decode(Schema.Finite, row.starts_at_ms)),
          endsAt: instant(decode(Schema.Finite, row.ends_at_ms)),
          renewalAnchor: instant(decode(Schema.Finite, row.renewal_anchor_ms)),
        };
  const recentAttempts = attemptRows.map(projectAttempt);
  const data = decode(Schema.toCodecJson(SubscriptionStatus), {
    accessTier:
      (row.started_at_ms <= now && row.trial_ends_at_ms > now) ||
      (row.starts_at_ms !== null &&
        row.starts_at_ms <= now &&
        row.ends_at_ms !== null &&
        row.ends_at_ms > now)
        ? "pro"
        : "free",
    trialPeriod: { startedAt: instant(row.started_at_ms), endsAt: instant(row.trial_ends_at_ms) },
    paidSubscription,
    recentAttempts,
  });
  return data;
};
