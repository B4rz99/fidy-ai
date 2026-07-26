import { DateTime, Effect } from "effect";
import { TransactionNotYetOccurred } from "./errors";

/**
 * Decides whether a movement about to be recorded has actually happened.
 *
 * A Transaction is money that moved (CONTEXT.md), so `occurredAt` may be any
 * instant up to and including `now`, and nothing after it. The same instant is
 * accepted: a capture that races the clock to the millisecond is a real
 * movement, not a future-dated one.
 *
 * `now` is a parameter rather than a clock read, because core reads no clock
 * (ARCHITECTURE.md §3); the caller supplies the instant it is deciding at, and
 * the same pair always gives the same answer. Both instants are named fields
 * rather than positional arguments, so a call site cannot swap them silently.
 */
export const checkAlreadyOccurred = (occurrence: {
  readonly occurredAt: DateTime.Utc;
  readonly now: DateTime.Utc;
}): Effect.Effect<void, TransactionNotYetOccurred> =>
  DateTime.isGreaterThan(occurrence.occurredAt, occurrence.now)
    ? Effect.fail(new TransactionNotYetOccurred(occurrence))
    : Effect.void;
