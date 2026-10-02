import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/unstable/sql";
import { User } from "~/core/identity/contract";
import { UserId } from "~/core/identity/reference";
import { protectConsentStatement } from "~/shell/consent/operations";

const UserRow = Schema.Struct({
  id: UserId,
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
  created_at_ms: Schema.Finite,
  started_at_ms: Schema.Finite,
  ends_at_ms: Schema.Finite,
});

/** Decode the selected User without publishing its persisted representation. */
export const findUser = (
  userId: UserId
): Effect.Effect<
  Option.Option<User>,
  Schema.SchemaError | SqlError.SqlError,
  SqlClient.SqlClient
> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: UserId,
      Result: UserRow,
      execute: (subject) => {
        const query = protectConsentStatement({
          statement: {
            sql: `SELECT u.id, u.service_market, u.locale, u.time_zone, u.created_at_ms,
              t.started_at_ms, t.ends_at_ms FROM users AS u JOIN trial_periods AS t ON t.user_id = u.id
              WHERE u.id = ?`,
            params: [subject],
          },
          subject: { _tag: "Owner", column: "u.id" },
          requirement: "granted",
        });
        return sql.unsafe(query.sql, query.params);
      },
    })(userId)
  ).pipe(
    Effect.flatMap((row) =>
      Option.match(row, {
        onNone: () => Effect.succeedNone,
        onSome: (value) =>
          Schema.decodeUnknownEffect(Schema.toType(User))({
            id: value.id,
            serviceMarket: value.service_market,
            locale: value.locale,
            timeZone: value.time_zone,
            createdAt: DateTime.makeUnsafe(value.created_at_ms),
            trialPeriod: {
              startedAt: DateTime.makeUnsafe(value.started_at_ms),
              endsAt: DateTime.makeUnsafe(value.ends_at_ms),
            },
          }).pipe(Effect.asSome),
      })
    )
  );
