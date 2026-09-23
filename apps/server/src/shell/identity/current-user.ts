import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { User } from "~/core/identity/model";
import { UserId } from "~/core/identity/reference";
import { Unavailable } from "~/shell/public-http/contract";

const UserRow = Schema.Struct({
  id: UserId,
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
  created_at_ms: Schema.Finite,
  started_at_ms: Schema.Finite,
  ends_at_ms: Schema.Finite,
});

const userUnavailable = (): Unavailable =>
  Unavailable.make({
    error: { code: "unavailable", message: "User data is temporarily unavailable. Retry later." },
    next: [],
  });

/** Load one User from authoritative state, scoped solely by the resolved stable UserId. */
export const getCurrentUser = (
  userId: UserId
): Effect.Effect<
  { readonly data: User; readonly next: ReadonlyArray<never> },
  Unavailable,
  SqlClient.SqlClient
> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    SqlSchema.findOneOption({
      Request: UserId,
      Result: UserRow,
      execute: (
        subject
      ) => sql`SELECT u.id, u.service_market, u.locale, u.time_zone, u.created_at_ms,
        t.started_at_ms, t.ends_at_ms FROM users AS u JOIN trial_periods AS t ON t.user_id = u.id
        WHERE u.id = ${subject} AND EXISTS (SELECT 1 FROM onboarding_consent_records AS c WHERE c.user_id = u.id)`,
    })(userId)
  ).pipe(
    Effect.flatMap((row) =>
      Option.match(row, {
        onNone: () => Effect.fail(userUnavailable()),
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
          }).pipe(Effect.mapError(userUnavailable)),
      })
    ),
    Effect.map((data) => ({ data, next: [] as const })),
    Effect.mapError(userUnavailable)
  );
