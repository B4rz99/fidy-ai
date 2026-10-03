import { UserContext } from "../../../../src/core/identity/contract";
import { Effect, Option, Schema } from "effect";
import {
  type UserContextRead,
  type UserContextStatement,
  UserContextUnavailable,
} from "../contract";

export const loadContext = ({
  db,
  userId,
  authority,
}: UserContextRead): Effect.Effect<Option.Option<UserContext>, UserContextUnavailable> =>
  Effect.gen(function* () {
    const guard = Option.isNone(authority)
      ? ""
      : ` AND EXISTS (SELECT 1 FROM (${authority.value.sql}) AS context_authority WHERE context_authority.userId = users.id)`;
    const raw = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(`SELECT service_market AS serviceMarket, locale, time_zone AS timeZone
        FROM users WHERE id = ?${guard}`)
          .bind(
            userId,
            ...Option.match(authority, { onNone: () => [], onSome: (value) => value.params })
          )
          .first(),
      catch: () => new UserContextUnavailable(),
    });
    if (raw === null) return Option.none();
    return Option.some(yield* Schema.decodeUnknownEffect(UserContext)(raw));
  }).pipe(Effect.mapError(() => new UserContextUnavailable()));

export const prepareContext = ({
  db,
  userId,
  statement,
}: UserContextStatement): D1PreparedStatement =>
  db
    .prepare(`WITH identity_user_context AS (
    SELECT id AS userId, service_market AS serviceMarket, locale, time_zone AS timeZone
    FROM users WHERE id = ?
  ) ${statement.sql}`)
    .bind(userId, ...statement.params);
