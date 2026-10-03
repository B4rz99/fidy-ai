import type { Effect, Option } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import type { TransactionCaller } from "../canonical-work/operations";
import type { RecurringConfirmationPage, RecurringUnavailable } from "./contract";
import { readConfirmations } from "./internal/confirmations";
import { discover, evaluate } from "./internal/evaluation";
import { list } from "./internal/query";

/** Advance one bounded evaluation step under this User's existing coordinator and live processing Consent. */
export const evaluateRecurringSeries = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<void, RecurringUnavailable> => evaluate(input);
/** Discover at most four pending User identities; recheck authority inside each coordinator before reading facts. */
export const discoverRecurringWork = (
  db: D1Database
): Effect.Effect<ReadonlyArray<UserId>, RecurringUnavailable> => discover(db);
/** Read immutable confirmation snapshots under current Consent inside this User's coordinator; invalid patterns are excluded. */
export const readRecurringConfirmations = (
  input: Readonly<{ db: D1Database; userId: UserId; cursor: Option.Option<string> }>
): Effect.Effect<RecurringConfirmationPage, RecurringUnavailable> => readConfirmations(input);
/** Execute the Free read-scoped query with atomic live credential, Consent, Audit and decoded page status. */
export const listRecurringSeries = (
  input: Readonly<{ db: D1Database; subject: TransactionCaller; request: Request }>
): Effect.Effect<Response> => list(input);
