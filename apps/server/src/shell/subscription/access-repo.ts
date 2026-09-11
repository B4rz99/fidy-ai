import { Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import { SubscriptionStanding } from "~/core/subscription/model";

/** Reads Subscription-owned paid Pro standing inside the caller's User-scoped transaction. */
export const hasPaidProInScope = Effect.fn("Subscription.hasPaidProInScope")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: SubscriptionStanding,
    execute: () => sql`
      SELECT paid_pro_active AS "paidProActive"
      FROM subscriptions
      WHERE user_id = ${userId}
    `,
  })(undefined).pipe(Effect.orDie);
  return row.paidProActive;
});

/** Creates the initial non-paid Subscription standing in an existing onboarding transaction. */
export const createInitialSubscriptionInScope = Effect.fn(
  "Subscription.createInitialSubscriptionInScope"
)(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO subscriptions (user_id, paid_pro_active)
    VALUES (${userId}, false)
  `;
}, Effect.orDie);

/** Activates paid Pro inside a caller-owned transaction after verified Subscription settlement. */
export const activatePaidProInScope = Effect.fn("Subscription.activatePaidProInScope")(function* (
  userId: UserId
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE subscriptions
    SET paid_pro_active = true
    WHERE user_id = ${userId}
  `;
}, Effect.orDie);

/** Creates or replaces Subscription standing for development and real-Postgres fixtures. */
export const upsertDevelopmentSubscriptionInScope = Effect.fn(
  "Subscription.upsertDevelopmentSubscriptionInScope"
)(function* (userId: UserId, paidProActive: boolean) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO subscriptions (user_id, paid_pro_active)
    VALUES (${userId}, ${paidProActive})
    ON CONFLICT (user_id) DO UPDATE
    SET paid_pro_active = EXCLUDED.paid_pro_active
  `;
}, Effect.orDie);
