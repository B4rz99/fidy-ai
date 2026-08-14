import { Data, Effect, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";

const UserContextMatchRow = Schema.Struct({ matches: Schema.Boolean });

class TransactionBodyFailure<E> extends Data.TaggedError("TransactionBodyFailure")<{
  readonly error: E;
}> {}

/**
 * Runs database work on one reserved connection inside a short transaction whose
 * PostgreSQL User context is local to that transaction. Nested calls may repeat
 * the same User but cannot switch subjects. Commit, rollback, and interruption
 * clear the setting before the pooled connection can be reused. Failures from
 * the supplied body remain typed; transaction-management SQL failures are defects.
 */
export const withUserTransaction = Effect.fn("withUserTransaction")(function* <A, E, R>(
  userId: UserId,
  effect: Effect.Effect<A, E, R>
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const { matches } = yield* SqlSchema.findOne({
          Request: Schema.Void,
          Result: UserContextMatchRow,
          execute: () => sql`
            SELECT set_config(
              'fidy.user_id',
              COALESCE(NULLIF(current_setting('fidy.user_id', true), ''), ${userId}::text),
              true
            ) = ${userId}::text AS matches
          `,
        })(undefined).pipe(Effect.orDie);

        if (!matches) {
          return yield* Effect.die(new Error("A database transaction cannot switch User context."));
        }
        return yield* effect.pipe(
          Effect.mapError((error) => new TransactionBodyFailure({ error }))
        );
      })
    )
    .pipe(
      Effect.catchTags({
        SqlError: (error) => Effect.die(error),
        TransactionBodyFailure: ({ error }) => Effect.fail(error),
      })
    );
});
