import { UserContext } from "../../../src/core/identity/contract";
import { Effect, Option, Schema } from "effect";
import {
  type UserContextRead,
  type UserContextStatement,
  UserContextUnavailable,
} from "./contract";

/**
 * Read independently stored context for the explicit stable User. Absence grants no authority.
 * An optional credential-owner query must project userId; only that same subject can release
 * context. The owner query is re-evaluated together with the read, never used as a cached permit.
 */
export const readUserContext = ({
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

/**
 * Compose current context with one resolved User's interpretation or historical snapshot action.
 * identity_user_context exposes only userId, serviceMarket, locale and timeZone for that User;
 * the caller supplies trusted static SQL referencing this projection, never Identity storage.
 * Commit the prepared action in the caller's existing D1 unit. Context is observed at execution,
 * so a previously read preference cannot replace the context current when the action commits.
 */
export const prepareUserContext = ({
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
