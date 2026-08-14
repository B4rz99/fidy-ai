import { DateTime, Effect, Option } from "effect";
import { type ReadonlyOption, toOption } from "~/core/_shared/option";
import { InvalidTransactionPeriod, TransactionNotYetOccurred } from "./errors";

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
export const checkAlreadyOccurred = (
  occurrence: Readonly<{
    readonly occurredAt: DateTime.Utc;
    readonly now: DateTime.Utc;
  }>
): Effect.Effect<void, TransactionNotYetOccurred> =>
  DateTime.isGreaterThan(occurrence.occurredAt, occurrence.now)
    ? Effect.fail(new TransactionNotYetOccurred(occurrence))
    : Effect.void;

type TransactionPeriod = Readonly<{
  readonly from: ReadonlyOption<DateTime.Utc>;
  readonly to: ReadonlyOption<DateTime.Utc>;
}>;

type PeriodBounds = Readonly<{
  readonly from: DateTime.Utc;
  readonly to: DateTime.Utc;
}>;

const checkPeriodWidth = (
  bounds: PeriodBounds
): Effect.Effect<void> | Effect.Effect<never, InvalidTransactionPeriod> =>
  DateTime.isLessThan(bounds.from, bounds.to)
    ? Effect.void
    : Effect.fail(new InvalidTransactionPeriod(bounds));

/** A two-ended period must have positive width; either end may be omitted. */
export const checkTransactionPeriod = (
  period: TransactionPeriod
): Effect.Effect<void> | Effect.Effect<never, InvalidTransactionPeriod> =>
  Option.match(Option.all({ from: toOption(period.from), to: toOption(period.to) }), {
    onNone: () => Effect.void,
    onSome: checkPeriodWidth,
  });
