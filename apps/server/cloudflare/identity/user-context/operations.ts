import type { UserContext } from "@fidy/server/identity-contract";
import type { Effect, Option } from "effect";
import type { UserContextRead, UserContextStatement, UserContextUnavailable } from "./contract";
import { loadContext, prepareContext } from "./internal/context";

/**
 * Read independently stored context for the explicit stable User. Absence grants no authority.
 * An optional credential-owner query must project userId; only that same subject can release
 * context. The owner query is re-evaluated together with the read, never used as a cached permit.
 */
export const readUserContext = (
  input: UserContextRead
): Effect.Effect<Option.Option<UserContext>, UserContextUnavailable> => loadContext(input);

/**
 * Compose current context with one resolved User's interpretation or historical snapshot action.
 * identity_user_context exposes only userId, serviceMarket, locale and timeZone for that User;
 * the caller supplies trusted static SQL referencing this projection, never Identity storage.
 * Commit the prepared action in the caller's existing D1 unit. Context is observed at execution,
 * so a previously read preference cannot replace the context current when the action commits.
 */
export const prepareUserContext = (input: UserContextStatement): D1PreparedStatement =>
  prepareContext(input);
