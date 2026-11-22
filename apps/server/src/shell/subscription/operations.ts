import { type PreparedSubscriptionRead, type SubscriptionReadAuthority } from "./contract";
import {
  paidAccessEndSql,
  subscriptionAttemptsQuery,
  subscriptionStandingQuery,
} from "~/shell/subscription/internal/query-sql";
import {
  projectSubscriptionStatus,
  listSubscriptionOffersResponse as readOffers,
  readSubscriptionStatus,
} from "~/shell/subscription/internal/queries";
import { Effect, Option, Schema } from "effect";
import { type SqlClient } from "effect/sql";
import { type UserId } from "~/core/identity/contract";
import { type SubscriptionOffers, SubscriptionStatus } from "~/core/subscription/contract";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import { type Unavailable } from "~/shell/public-http/contract";

export const listSubscriptionOffersResponse: Effect.Effect<
  { readonly data: SubscriptionOffers; readonly next: ReadonlyArray<never> },
  Unavailable,
  SqlClient.SqlClient
> = Effect.suspend(() => readOffers);

export const getSubscriptionStatus = (
  userId: UserId
): Effect.Effect<
  { readonly data: SubscriptionStatus; readonly next: ReadonlyArray<never> },
  Unavailable,
  SqlClient.SqlClient
> => readSubscriptionStatus(userId);

export const activePaidSubscriptionCondition = ({
  userId,
  nowEpochMs,
}: Readonly<{ userId: UserId; nowEpochMs: number }>): OwnedStatement =>
  activePaidSubscriptionForUserSelection({
    users: { sql: "SELECT ?", params: [userId] },
    nowEpochMs,
  });

export const activePaidSubscriptionForUserSelection = ({
  users,
  nowEpochMs,
}: Readonly<{ users: OwnedStatement; nowEpochMs: number }>): OwnedStatement => ({
  sql: `EXISTS (SELECT 1 FROM subscription_standing s
    JOIN billing_attempt_context a ON a.id=s.attempt_id AND a.paid_starts_at_ms IS NOT NULL AND a.user_id=s.user_id
    JOIN payment_source_context source ON source.id=a.payment_source_id AND source.user_id=a.user_id
    WHERE s.user_id IN (${users.sql}) AND (${paidAccessEndSql}) > ? AND a.paid_starts_at_ms<=?)`,
  params: [...users.params, nowEpochMs, nowEpochMs],
});

export const prepareSubscriptionStatus = (
  input: Readonly<{
    authority: SubscriptionReadAuthority;
    current: number;
  }> &
    (Readonly<{ userId: UserId }> | Readonly<{ users: OwnedStatement }>)
): PreparedSubscriptionRead => {
  Schema.decodeSync(Schema.Finite)(input.current);

  const users =
    "users" in input ? input.users : { sql: "SELECT ? AS userId", params: [input.userId] };

  const owner: OwnedStatement = {
    sql: `WITH candidates(userId) AS MATERIALIZED (SELECT DISTINCT userId FROM (${users.sql}))
      SELECT userId FROM candidates WHERE (SELECT COUNT(*) FROM candidates)=1`,
    params: users.params,
  };

  return {
    statements: [
      subscriptionStandingQuery({ users: owner, authority: Option.some(input.authority) }),
      subscriptionAttemptsQuery({ users: owner, authority: Option.some(input.authority) }),
    ],
    decode: (rows) =>
      Schema.encodeSync(Schema.toCodecJson(SubscriptionStatus))(
        projectSubscriptionStatus({
          standingRow: rows[0]?.[0],
          attemptRows: rows[1] ?? [],
          now: input.current,
        })
      ),
  };
};
