import { Effect, Schema } from "effect";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { User, UserId } from "~/core/identity/contract";

import { protectConsentStatement } from "~/shell/consent/operations";

const UserRow = Schema.Struct({
  id: UserId,
  service_market: Schema.String,
  locale: Schema.String,
  time_zone: Schema.String,
  created_at_ms: Schema.DateTimeUtcFromMillis,
  started_at_ms: Schema.DateTimeUtcFromMillis,
  ends_at_ms: Schema.DateTimeUtcFromMillis,
});

export const currentUserQuery = (userId: UserId): OwnedStatement =>
  protectConsentStatement({
    statement: {
      sql: `SELECT u.id, u.service_market, u.locale, u.time_zone, u.created_at_ms,
              t.started_at_ms, t.ends_at_ms FROM users AS u JOIN trial_periods AS t ON t.user_id = u.id
              WHERE u.id = ?`,
      params: [userId],
    },
    subject: { _tag: "Owner", column: "u.id" },
    requirement: "granted",
  });

/** Decode the selected User without publishing its persisted representation. */
export const decodeUser = (row: unknown): Effect.Effect<User, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(UserRow)(row).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(Schema.toType(User))({
        id: value.id,
        serviceMarket: value.service_market,
        locale: value.locale,
        timeZone: value.time_zone,
        createdAt: value.created_at_ms,
        trialPeriod: {
          startedAt: value.started_at_ms,
          endsAt: value.ends_at_ms,
        },
      })
    )
  );
